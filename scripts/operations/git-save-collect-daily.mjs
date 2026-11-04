#!/usr/bin/env node
/**
 * NEXORA Phase 2-B — Daily Completed & Verified Work Collector for GitHub Save (SYNC-02).
 *
 * Strictly READ-ONLY collector that inspects:
 *   1. Today's completed NEXORA issues and assigned AI employees (Asia/Seoul 00:00 ~ next day 00:00)
 *   2. Actual verification/test records for those issues and task runs
 *   3. Today's Git commits and their changed files
 *   4. Current working-tree modified, added, deleted, renamed, untracked, and conflicted files
 *   5. CLI / local runner records and unattributed CLI working-tree changes
 *
 * Classification Policy (Fail-Closed):
 *   - Category A (SAVE_CANDIDATE):
 *       Today's completion record exists + verification pass record exists +
 *       single clear owner with explicit file linkage + zero conflict with active work.
 *   - Category B (NEEDS_REVIEW):
 *       Suspected CLI work with unclear owner, insufficient completion/verification evidence,
 *       possible mixed changes from multiple employees, or uncertain issue-to-file linkage.
 *   - Category C (EXCLUDED):
 *       In-progress/incomplete work, failed/unexecuted verification, Git/concurrent conflicts,
 *       or unsafe/protected/sensitive/ambiguous files that cannot be safely saved.
 *
 * Safety Invariants:
 *   - NEVER stages, commits, pushes, fetches, merges, rebases, resets, or cleans.
 *   - NEVER modifies existing source files, database records, or Git state (.git/index, HEAD, objects).
 *   - NEVER trusts file mtime alone to infer task owner or completion status.
 *   - NEVER auto-generates an approved Git Save v2 manifest for unverified files.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  ALLOWED_BRANCH,
  ALLOWED_REMOTES,
  ALLOWED_REMOTE_URLS,
  VERIFY_PROFILES,
  isSafeApprovedPath,
  validateApprovedPathOnDisk,
} from "./git-save.mjs";
import { validatePrepareRequest } from "./git-save-prepare.mjs";

export const KST_TIMEZONE = "Asia/Seoul";
export const KST_OFFSET_MS = 9 * 60 * 60 * 1000; // UTC+09:00 (no DST in Korea)

export const CANDIDATE_CATEGORIES = Object.freeze({
  SAVE_CANDIDATE: "SAVE_CANDIDATE",
  NEEDS_REVIEW: "NEEDS_REVIEW",
  EXCLUDED: "EXCLUDED",
});

export const KNOWN_NEXORA_AGENTS_AND_CLIS = Object.freeze([
  { id: "JARVIS", kind: "agent", label: "JARVIS (총괄 오케스트레이터)" },
  { id: "Atlas", kind: "agent", label: "Atlas (COO / 부서 조율)" },
  { id: "Antigravity", kind: "agent_cli", label: "Antigravity (프론트엔드·UI 에이전트 / CLI)" },
  { id: "Claude Code", kind: "agent_cli", label: "Claude Code (백엔드·서버·게이트 에이전트 / CLI)" },
  { id: "Codex", kind: "agent_cli", label: "Codex (로컬 어댑터 / CLI)" },
  { id: "Paperclip CLI", kind: "cli", label: "Paperclip CLI (paperclipai 명령 도구)" },
]);

export const PROTECTED_GATE_AND_ENGINE_PATHS = Object.freeze([
  ".agents/hooks.json",
  ".agents/trust-policy.cjs",
  ".agents/claude-trust-policy.cjs",
  ".agents/lib/",
  ".agents/antigravity-runner/",
  "scripts/operations/git-save.mjs",
  "scripts/operations/git-save-prepare.mjs",
  "scripts/operations/git-save.test.mjs",
  "scripts/operations/GIT-SAVE-AUTOMATION.md",
]);

export const CONTENDED_SHARED_CORE_PATHS = Object.freeze([
  "server/src/app.ts",
  "server/src/services/index.ts",
  "server/src/services/heartbeat.ts",
  "server/src/routes/issues.ts",
  "packages/db/src/migrations/meta/_journal.json",
]);

const SENSITIVE_OR_TEMP_REGEXES = [
  /^\.env(\..+)?$/i,
  /(?:^|\/)\.env\.(?!example$)[^/]+$/i,
  /^secrets\//i,
  /\.(?:pem|key|p12|pfx)$/i,
  /^scratch\//i,
  /^tmp\//i,
  /^tmp-/i,
  /^\.tmp-/i,
  /\.tmp$/i,
  /^test-results\//i,
  /^tests\/e2e\/test-results\//i,
  /^tests\/e2e\/playwright-report\//i,
  /^data\//i,
  /^diagnostics\//i,
  /^registry-monitor-/i,
  /^nexora-registry\.json$/i,
  /^\.paperclip/i,
];

function toPosixPath(p) {
  return String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function normalizePathKey(p) {
  return toPosixPath(p).toLowerCase();
}

function gitReadOnly(repoRoot, args) {
  return execFileSync("git", ["--no-optional-locks", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function pad3(n) {
  return String(n).padStart(3, "0");
}

/**
 * Formats a Date / epoch ms / ISO string as an explicit KST (+09:00) ISO timestamp.
 */
export function formatKstTimestamp(input) {
  const ms = input instanceof Date ? input.getTime() : typeof input === "number" ? input : Date.parse(String(input));
  if (!Number.isFinite(ms)) return null;
  const kstDate = new Date(ms + KST_OFFSET_MS);
  const y = kstDate.getUTCFullYear();
  const m = pad2(kstDate.getUTCMonth() + 1);
  const d = pad2(kstDate.getUTCDate());
  const hh = pad2(kstDate.getUTCHours());
  const mm = pad2(kstDate.getUTCMinutes());
  const ss = pad2(kstDate.getUTCSeconds());
  const mmm = pad3(kstDate.getUTCMilliseconds());
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}.${mmm}+09:00`;
}

/**
 * Computes the exact [00:00:00.000+09:00, next day 00:00:00.000+09:00) window
 * in Asia/Seoul (KST) for a given calendar date ("YYYY-MM-DD") or reference timestamp.
 */
export function computeKstDayWindow(dateOrNow = new Date()) {
  let dateKst;
  if (typeof dateOrNow === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateOrNow.trim())) {
    dateKst = dateOrNow.trim();
  } else {
    const ms =
      dateOrNow instanceof Date
        ? dateOrNow.getTime()
        : typeof dateOrNow === "number"
          ? dateOrNow
          : Date.parse(String(dateOrNow));
    if (!Number.isFinite(ms)) {
      throw new Error(`Invalid date or timestamp for KST window: ${JSON.stringify(dateOrNow)}`);
    }
    const shifted = new Date(ms + KST_OFFSET_MS);
    dateKst = `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
  }

  const [yearStr, monthStr, dayStr] = dateKst.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);

  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() + 1 !== month ||
    probe.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date for KST window: ${dateKst}`);
  }

  const nextProbe = new Date(Date.UTC(year, month - 1, day + 1));
  const nextDateKst = `${nextProbe.getUTCFullYear()}-${pad2(nextProbe.getUTCMonth() + 1)}-${pad2(nextProbe.getUTCDate())}`;

  const startKst = `${dateKst}T00:00:00.000+09:00`;
  const endKst = `${nextDateKst}T00:00:00.000+09:00`;
  const startMs = Date.parse(startKst);
  const endMs = Date.parse(endKst);

  return {
    timezone: KST_TIMEZONE,
    dateKst,
    nextDateKst,
    startKst,
    endKst,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    startMs,
    endMs,
  };
}

/**
 * Checks whether a timestamp falls within [window.startMs, window.endMs).
 */
export function isWithinKstDayWindow(timestampInput, kstWindow) {
  if (timestampInput === null || timestampInput === undefined || timestampInput === "") {
    return false;
  }
  const ms =
    timestampInput instanceof Date
      ? timestampInput.getTime()
      : typeof timestampInput === "number"
        ? timestampInput
        : Date.parse(String(timestampInput));
  if (!Number.isFinite(ms)) return false;
  return ms >= kstWindow.startMs && ms < kstWindow.endMs;
}

/**
 * Parses `git status --porcelain=v1 -z -uall` NUL-delimited output without path quoting issues.
 */
export function parsePorcelainV1Z(rawOutput) {
  if (!rawOutput) return [];
  const tokens = rawOutput.split("\0");
  const entries = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || token.length < 4) continue;
    const indexStatus = token[0];
    const workTreeStatus = token[1];
    const porcelainCode = `${indexStatus}${workTreeStatus}`;
    const rawPath = token.slice(3);
    let origPath = null;
    if (indexStatus === "R" || indexStatus === "C" || workTreeStatus === "R" || workTreeStatus === "C") {
      origPath = toPosixPath(tokens[i + 1] ?? "");
      i += 1;
    }

    const filePath = toPosixPath(rawPath);
    const isConflicted =
      porcelainCode === "UU" ||
      porcelainCode === "AA" ||
      porcelainCode === "DD" ||
      porcelainCode === "AU" ||
      porcelainCode === "UA" ||
      porcelainCode === "DU" ||
      porcelainCode === "UD";
    const isUntracked = porcelainCode === "??";
    const isDeleted = indexStatus === "D" || workTreeStatus === "D";
    const isAdded = indexStatus === "A" || isUntracked;
    const isRenamed = indexStatus === "R" || workTreeStatus === "R";
    const isStaged = indexStatus !== " " && indexStatus !== "?";

    let changeKind = "modified";
    if (isConflicted) changeKind = "conflicted";
    else if (isUntracked) changeKind = "untracked";
    else if (isRenamed) changeKind = "renamed";
    else if (isDeleted) changeKind = "deleted";
    else if (isAdded) changeKind = "added";

    entries.push({
      path: filePath,
      origPath,
      porcelainCode,
      indexStatus,
      workTreeStatus,
      changeKind,
      isConflicted,
      isUntracked,
      isDeleted,
      isStaged,
    });
  }
  return entries;
}

export function isSensitiveOrTempArtifactPath(relPath) {
  const normalized = toPosixPath(relPath);
  if (normalized === ".env.example") return false;
  return SENSITIVE_OR_TEMP_REGEXES.some((re) => re.test(normalized));
}

export function isProtectedGateOrEnginePath(relPath) {
  const normalized = normalizePathKey(relPath);
  for (const entry of PROTECTED_GATE_AND_ENGINE_PATHS) {
    const normEntry = normalizePathKey(entry);
    if (entry.endsWith("/")) {
      if (normalized === normEntry || normalized.startsWith(`${normEntry}/`)) return true;
    } else if (normalized === normEntry) {
      return true;
    }
  }
  return false;
}

export function isContendedSharedCorePath(relPath) {
  const normalized = normalizePathKey(relPath);
  return CONTENDED_SHARED_CORE_PATHS.some((entry) => normalizePathKey(entry) === normalized);
}

/**
 * Collects Git branch, HEAD, remote tracking state, today's commits (in KST window),
 * and working-tree status using strictly read-only `--no-optional-locks` commands.
 */
export function collectGitStateReadOnly(repoRoot, kstWindow) {
  const branch = gitReadOnly(repoRoot, ["branch", "--show-current"]).trim();
  const headSha = gitReadOnly(repoRoot, ["rev-parse", "HEAD"]).trim();

  let remoteHeadSha = null;
  let isAncestorOfHead = false;
  try {
    remoteHeadSha = gitReadOnly(repoRoot, ["rev-parse", `refs/remotes/${ALLOWED_REMOTES[0]}/${ALLOWED_BRANCH}`]).trim();
    try {
      gitReadOnly(repoRoot, ["merge-base", "--is-ancestor", remoteHeadSha, headSha]);
      isAncestorOfHead = true;
    } catch {
      isAncestorOfHead = false;
    }
  } catch {
    remoteHeadSha = null;
    isAncestorOfHead = false;
  }

  const stagedRaw = gitReadOnly(repoRoot, ["diff", "--cached", "--name-only", "-z"]);
  const stagedFiles = stagedRaw
    .split("\0")
    .filter(Boolean)
    .map((f) => toPosixPath(f));

  const statusRaw = gitReadOnly(repoRoot, ["status", "--porcelain=v1", "-z", "-uall"]);
  const workingTreeEntries = parsePorcelainV1Z(statusRaw);

  // Query recent commits and filter strictly by KST window [startMs, endMs)
  const logFormat = "%H%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%P%x1f%s%x1e";
  const rawLog = gitReadOnly(repoRoot, ["log", "-n", "200", `--format=${logFormat}`, "HEAD"]);
  const todayCommits = [];

  for (const record of rawLog.split("\x1e")) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const [sha, authorName, authorEmail, authorIso, committerIso, parentsRaw, subject] = trimmed.split("\x1f");
    if (!sha) continue;

    // Check committer timestamp (or author timestamp fallback) against KST window
    const timestampToCheck = committerIso || authorIso;
    if (!isWithinKstDayWindow(timestampToCheck, kstWindow)) continue;

    const parents = (parentsRaw || "").trim().split(/\s+/).filter(Boolean);
    const isMergeCommit = parents.length > 1;

    let changedFiles = [];
    if (!isMergeCommit) {
      const diffTreeRaw = gitReadOnly(repoRoot, [
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--name-status",
        "-r",
        "-z",
        sha,
      ]);
      const tokens = diffTreeRaw.split("\0").filter(Boolean);
      for (let i = 0; i < tokens.length; i += 2) {
        const status = tokens[i];
        const filePath = tokens[i + 1];
        if (!status || !filePath) continue;
        if (status.startsWith("R") || status.startsWith("C")) {
          const newPath = tokens[i + 2];
          if (newPath) {
            changedFiles.push({ status: status[0], path: toPosixPath(newPath), origPath: toPosixPath(filePath) });
            i += 1;
            continue;
          }
        }
        changedFiles.push({ status: status[0], path: toPosixPath(filePath), origPath: null });
      }
    }

    let pushedToRemote = false;
    if (remoteHeadSha) {
      try {
        gitReadOnly(repoRoot, ["merge-base", "--is-ancestor", sha, remoteHeadSha]);
        pushedToRemote = true;
      } catch {
        pushedToRemote = false;
      }
    }

    todayCommits.push({
      sha,
      shortSha: sha.slice(0, 8),
      authorName,
      authorEmail,
      authoredAt: authorIso,
      committedAt: committerIso,
      committedAtKst: formatKstTimestamp(committerIso || authorIso),
      subject,
      isMergeCommit,
      pushedToRemote,
      changedFiles,
    });
  }

  return {
    repoRoot,
    branch,
    headSha,
    remoteHeadSha,
    isAncestorOfHead,
    hasStagedFiles: stagedFiles.length > 0,
    stagedFiles,
    workingTreeEntries,
    todayCommits,
  };
}

/**
 * Collects Antigravity Task Runner records from `.agents/antigravity-runner/runs` (read-only).
 */
export function collectRunnerRecordsReadOnly(repoRoot, kstWindow) {
  const runsDir = path.join(repoRoot, ".agents", "antigravity-runner", "runs");
  if (!existsSync(runsDir)) {
    return {
      inspectable: false,
      reason: "`.agents/antigravity-runner/runs` 디렉터리가 존재하지 않음 (Antigravity CLI 러너 실행 이력 없음)",
      runsToday: [],
      activeRuns: [],
    };
  }

  let dirEntries = [];
  try {
    dirEntries = readdirSync(runsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch (err) {
    return {
      inspectable: false,
      reason: `Antigravity 러너 디렉터리 읽기 실패: ${err.message}`,
      runsToday: [],
      activeRuns: [],
    };
  }

  const runsToday = [];
  const activeRuns = [];

  for (const dirent of dirEntries) {
    const runPath = path.join(runsDir, dirent.name);
    const scopePath = path.join(runPath, "active-task-scope.json");
    const reportPath = path.join(runPath, "report.json");

    let scope = null;
    let report = null;
    if (existsSync(scopePath)) {
      try {
        scope = JSON.parse(readFileSync(scopePath, "utf8"));
      } catch {
        scope = null;
      }
    }
    if (existsSync(reportPath)) {
      try {
        report = JSON.parse(readFileSync(reportPath, "utf8"));
      } catch {
        report = null;
      }
    }

    if (report) {
      const inWindow =
        isWithinKstDayWindow(report.completedAt, kstWindow) ||
        isWithinKstDayWindow(report.startedAt, kstWindow);
      if (!inWindow) continue;

      const verificationPassed =
        report.status === "DONE" &&
        report.verification?.exitCode === 0 &&
        report.scopeCompliance?.passed === true;

      runsToday.push({
        runFolder: dirent.name,
        taskId: report.taskId ?? scope?.taskId ?? dirent.name,
        taskName: report.taskName ?? scope?.taskName ?? dirent.name,
        owner: report.worker ?? scope?.worker ?? "antigravity",
        status: report.status ?? "UNCERTAIN",
        completedAt: report.completedAt ?? null,
        startedAt: report.startedAt ?? null,
        completedInKstWindow: isWithinKstDayWindow(report.completedAt, kstWindow),
        verificationPassed,
        verificationCommand: report.verification?.command ?? scope?.verificationCommand ?? null,
        verificationExitCode: report.verification?.exitCode ?? null,
        scopePassed: Boolean(report.scopeCompliance?.passed),
        changedFiles: Array.isArray(report.changedFiles) ? report.changedFiles.map(toPosixPath) : [],
        allowedPaths: Array.isArray(scope?.allowedPaths) ? scope.allowedPaths.map(toPosixPath) : [],
      });
    } else if (scope) {
      activeRuns.push({
        runFolder: dirent.name,
        taskId: scope.taskId ?? dirent.name,
        taskName: scope.taskName ?? dirent.name,
        owner: scope.worker ?? "antigravity",
        status: "IN_PROGRESS",
        allowedPaths: Array.isArray(scope.allowedPaths) ? scope.allowedPaths.map(toPosixPath) : [],
      });
    }
  }

  return {
    inspectable: true,
    reason: null,
    runsToday,
    activeRuns,
  };
}

/**
 * Normalizes a Paperclip snapshot (either provided in-memory/from JSON file or fetched from live API).
 */
export function analyzePaperclipRecords(snapshot, kstWindow) {
  if (!snapshot || typeof snapshot !== "object") {
    return {
      inspectable: false,
      reason: "Paperclip 서버 API 또는 이슈·에이전트 스냅샷 데이터가 제공되지 않음 (실시간 DB/API 미연결)",
      agents: [],
      completedIssuesToday: [],
      incompleteOrActiveIssues: [],
      taskClaimsByFile: new Map(),
      activeFileConflicts: new Map(),
    };
  }

  const agents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const issues = Array.isArray(snapshot.issues) ? snapshot.issues : [];
  const liveRuns = Array.isArray(snapshot.liveRuns) ? snapshot.liveRuns : [];
  const workProductsByIssueId = snapshot.workProductsByIssueId ?? {};

  const activeAgentIds = new Set(
    liveRuns
      .filter((r) => ["running", "queued", "scheduled_retry"].includes(String(r.status)))
      .map((r) => r.agentId)
      .filter(Boolean),
  );
  const activeIssueIds = new Set(
    liveRuns
      .filter((r) => ["running", "queued", "scheduled_retry"].includes(String(r.status)))
      .map((r) => r.issueId)
      .filter(Boolean),
  );

  const completedIssuesToday = [];
  const incompleteOrActiveIssues = [];
  const taskClaimsByFile = new Map();
  const activeFileConflicts = new Map();

  for (const issue of issues) {
    const agent = issue.assigneeAgentId ? agentById.get(issue.assigneeAgentId) : null;
    const ownerName =
      issue.assigneeAgentName ??
      agent?.name ??
      issue.executionAgentNameKey ??
      (issue.assigneeAgentId ? `agent:${issue.assigneeAgentId}` : null);

    const workProducts = Array.isArray(issue.workProducts)
      ? issue.workProducts
      : Array.isArray(workProductsByIssueId[issue.id])
        ? workProductsByIssueId[issue.id]
        : [];

    // Extract explicitly linked workspace files from work products or explicit issue.changedFiles
    const linkedFiles = new Set();
    if (Array.isArray(issue.changedFiles)) {
      for (const f of issue.changedFiles) {
        if (typeof f === "string" && f.trim()) linkedFiles.add(toPosixPath(f));
      }
    }
    for (const wp of workProducts) {
      const refPath = wp?.metadata?.resourceRef?.path ?? wp?.path ?? null;
      if (typeof refPath === "string" && refPath.trim()) {
        linkedFiles.add(toPosixPath(refPath));
      }
    }

    const isIssueActiveOrIncomplete =
      activeIssueIds.has(issue.id) ||
      (issue.assigneeAgentId && activeAgentIds.has(issue.assigneeAgentId) && issue.status !== "done") ||
      ["in_progress", "todo", "backlog", "blocked"].includes(String(issue.status));

    // Determine verification status for the issue
    let verificationStatus = "unknown";
    let verificationDetail = "검증 기록 없음";
    if (issue.verificationStatus === "passed" || issue.verificationPassed === true) {
      verificationStatus = "passed";
      verificationDetail = issue.verificationDetail || "이슈 검증 통과 기록 확인";
    } else if (issue.verificationStatus === "failed" || issue.verificationPassed === false) {
      verificationStatus = "failed";
      verificationDetail = issue.verificationDetail || "이슈 검증 실패 기록 확인";
    } else if (issue.verificationStatus === "unexecuted") {
      verificationStatus = "unexecuted";
      verificationDetail = issue.verificationDetail || "검증 미실행";
    } else if (workProducts.some((wp) => wp.status === "failed")) {
      verificationStatus = "failed";
      verificationDetail = "산출물(Work Product) 상태가 failed임";
    } else if (
      workProducts.length > 0 &&
      workProducts.every((wp) => wp.status === "approved" || wp.reviewState === "approved")
    ) {
      verificationStatus = "passed";
      verificationDetail = "산출물(Work Product) 승인 완료";
    }

    const completedTimestamp = issue.completedAt ?? (issue.status === "done" ? issue.updatedAt : null);
    const completedToday = issue.status === "done" && isWithinKstDayWindow(completedTimestamp, kstWindow);

    const summaryRecord = {
      issueId: issue.id,
      identifier: issue.identifier ?? issue.id,
      title: issue.title ?? "(제목 없음)",
      status: issue.status,
      owner: ownerName,
      completedAt: completedTimestamp ?? null,
      completedAtKst: completedTimestamp ? formatKstTimestamp(completedTimestamp) : null,
      completedToday,
      verificationStatus,
      verificationDetail,
      linkedFiles: [...linkedFiles],
    };

    if (completedToday) {
      completedIssuesToday.push(summaryRecord);
    } else if (isIssueActiveOrIncomplete || issue.status === "in_review") {
      incompleteOrActiveIssues.push(summaryRecord);
    }

    for (const filePath of linkedFiles) {
      const key = normalizePathKey(filePath);
      if (isIssueActiveOrIncomplete) {
        const list = activeFileConflicts.get(key) ?? [];
        list.push({
          source: "paperclip_issue",
          issueId: summaryRecord.identifier,
          title: summaryRecord.title,
          owner: ownerName ?? "미지정",
          status: issue.status,
        });
        activeFileConflicts.set(key, list);
      }

      const claims = taskClaimsByFile.get(key) ?? [];
      claims.push({
        source: "paperclip_issue",
        taskId: summaryRecord.identifier,
        title: summaryRecord.title,
        owner: ownerName,
        status: issue.status,
        completedToday,
        verificationStatus,
        verificationDetail,
        explicitFileLinkage: true,
      });
      taskClaimsByFile.set(key, claims);
    }
  }

  return {
    inspectable: true,
    reason: null,
    agents,
    completedIssuesToday,
    incompleteOrActiveIssues,
    taskClaimsByFile,
    activeFileConflicts,
  };
}

/**
 * Fetches live Paperclip API snapshot in strictly read-only GET mode if server is reachable.
 */
export async function fetchPaperclipSnapshotReadOnly({
  apiBaseUrl = "http://localhost:3100/api",
  companyId = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 2000,
} = {}) {
  if (typeof fetchImpl !== "function") {
    return { ok: false, reason: "fetch 구현체를 사용할 수 없음", snapshot: null };
  }

  async function getJson(urlPath) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${apiBaseUrl.replace(/\/+$/, "")}${urlPath}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} on GET ${urlPath}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    let targetCompanyId = companyId;
    if (!targetCompanyId) {
      const companies = await getJson("/companies");
      if (!Array.isArray(companies) || companies.length === 0) {
        return { ok: false, reason: "등록된 회사(company)가 없음", snapshot: null };
      }
      targetCompanyId = companies[0].id;
    }

    const [agents, issues, liveRuns] = await Promise.all([
      getJson(`/companies/${targetCompanyId}/agents`),
      getJson(`/companies/${targetCompanyId}/issues?limit=200`),
      getJson(`/companies/${targetCompanyId}/live-runs`).catch(() => []),
    ]);

    const workProductsByIssueId = {};
    const doneOrActiveIssues = Array.isArray(issues) ? issues.slice(0, 50) : [];
    for (const issue of doneOrActiveIssues) {
      if (!issue?.id) continue;
      try {
        workProductsByIssueId[issue.id] = await getJson(`/issues/${issue.id}/work-products`);
      } catch {
        workProductsByIssueId[issue.id] = [];
      }
    }

    return {
      ok: true,
      reason: null,
      snapshot: {
        companyId: targetCompanyId,
        agents: Array.isArray(agents) ? agents : [],
        issues: Array.isArray(issues) ? issues : [],
        liveRuns: Array.isArray(liveRuns) ? liveRuns : [],
        workProductsByIssueId,
      },
    };
  } catch (err) {
    return {
      ok: false,
      reason: `Paperclip API(${apiBaseUrl}) 읽기 전용 연결 실패: ${err.message}`,
      snapshot: null,
    };
  }
}

/**
 * Classifies a single working-tree changed file into:
 *   - Category A: SAVE_CANDIDATE
 *   - Category B: NEEDS_REVIEW
 *   - Category C: EXCLUDED
 *
 * Never relies on file mtime alone to determine owner or completion.
 */
export function classifyWorkingTreeEntry({
  repoRoot,
  entry,
  runnerClaims = [],
  runnerActiveConflicts = [],
  paperclipClaims = [],
  paperclipActiveConflicts = [],
  completedIssuesWithoutFiles = [],
}) {
  const filePath = entry.path;
  const allClaims = [...runnerClaims, ...paperclipClaims];
  const allActiveConflicts = [...runnerActiveConflicts, ...paperclipActiveConflicts];

  const distinctOwners = new Set(
    allClaims
      .map((c) => (typeof c.owner === "string" && c.owner.trim() ? c.owner.trim() : null))
      .filter(Boolean),
  );

  // 1. Check Category C (EXCLUDED) hard gates first
  if (entry.isConflicted) {
    return {
      path: filePath,
      changeKind: entry.changeKind,
      porcelainCode: entry.porcelainCode,
      category: CANDIDATE_CATEGORIES.EXCLUDED,
      reasonCode: "git_conflict",
      owner: distinctOwners.size === 1 ? [...distinctOwners][0] : null,
      completionEvidence: null,
      verificationEvidence: null,
      reasons: ["Git 병합/인덱스 충돌(unmerged) 상태인 파일이므로 자동 저장에서 제외합니다."],
    };
  }

  if (!isSafeApprovedPath(repoRoot, filePath)) {
    return {
      path: filePath,
      changeKind: entry.changeKind,
      porcelainCode: entry.porcelainCode,
      category: CANDIDATE_CATEGORIES.EXCLUDED,
      reasonCode: "unsafe_path",
      owner: null,
      completionEvidence: null,
      verificationEvidence: null,
      reasons: ["Git Save 안전 경로 규칙(isSafeApprovedPath)을 위반하는 경로입니다."],
    };
  }

  const diskCheck = validateApprovedPathOnDisk(repoRoot, filePath);
  if (!diskCheck.ok) {
    return {
      path: filePath,
      changeKind: entry.changeKind,
      porcelainCode: entry.porcelainCode,
      category: CANDIDATE_CATEGORIES.EXCLUDED,
      reasonCode: "invalid_on_disk_target",
      owner: null,
      completionEvidence: null,
      verificationEvidence: null,
      reasons: [`디스크 대상 검증 실패(심볼릭 링크 또는 디렉터리): ${diskCheck.reason}`],
    };
  }

  if (isSensitiveOrTempArtifactPath(filePath)) {
    return {
      path: filePath,
      changeKind: entry.changeKind,
      porcelainCode: entry.porcelainCode,
      category: CANDIDATE_CATEGORIES.EXCLUDED,
      reasonCode: "sensitive_or_temp_artifact",
      owner: null,
      completionEvidence: null,
      verificationEvidence: null,
      reasons: ["비밀값·환경설정·임시 scratch·테스트 산출물 경로이므로 저장 대상에서 제외합니다."],
    };
  }

  if (isProtectedGateOrEnginePath(filePath)) {
    return {
      path: filePath,
      changeKind: entry.changeKind,
      porcelainCode: entry.porcelainCode,
      category: CANDIDATE_CATEGORIES.EXCLUDED,
      reasonCode: "protected_gate_or_security_hook",
      owner: null,
      completionEvidence: null,
      verificationEvidence: null,
      reasons: ["보안 훅 또는 기존 Git Save Gate 보호 대상 파일이므로 자동 후보에서 제외합니다."],
    };
  }

  if (allActiveConflicts.length > 0) {
    const conflictDesc = allActiveConflicts
      .map((c) => `${c.taskId || c.issueId}(${c.owner}: ${c.status})`)
      .join(", ");
    return {
      path: filePath,
      changeKind: entry.changeKind,
      porcelainCode: entry.porcelainCode,
      category: CANDIDATE_CATEGORIES.EXCLUDED,
      reasonCode: "in_progress_or_active_conflict",
      owner: distinctOwners.size === 1 ? [...distinctOwners][0] : null,
      completionEvidence: `진행 중 작업 존재: ${conflictDesc}`,
      verificationEvidence: null,
      reasons: [`진행 중이거나 미완료된 작업과 충돌합니다 (${conflictDesc}).`],
    };
  }

  // Check if any linked claim is explicitly failed or unexecuted verification
  const failedOrUnexecutedClaims = allClaims.filter(
    (c) =>
      c.status === "FAILED" ||
      c.verificationStatus === "failed" ||
      c.verificationStatus === "unexecuted" ||
      (typeof c.verificationExitCode === "number" && c.verificationExitCode !== 0),
  );
  if (failedOrUnexecutedClaims.length > 0) {
    const failDesc = failedOrUnexecutedClaims
      .map((c) => `${c.taskId}(${c.owner ?? "미상"}: ${c.verificationDetail || c.status})`)
      .join(", ");
    return {
      path: filePath,
      changeKind: entry.changeKind,
      porcelainCode: entry.porcelainCode,
      category: CANDIDATE_CATEGORIES.EXCLUDED,
      reasonCode: "verification_failed_or_unexecuted",
      owner: distinctOwners.size === 1 ? [...distinctOwners][0] : null,
      completionEvidence: failDesc,
      verificationEvidence: failDesc,
      reasons: [`테스트 실패 또는 검증 미실행 기록이 확인되어 제외합니다 (${failDesc}).`],
    };
  }

  // Check if any linked claim is incomplete (not done / not completed today)
  const incompleteClaims = allClaims.filter(
    (c) => ["in_progress", "todo", "backlog", "blocked"].includes(String(c.status)),
  );
  if (incompleteClaims.length > 0) {
    const incDesc = incompleteClaims.map((c) => `${c.taskId}(${c.status})`).join(", ");
    return {
      path: filePath,
      changeKind: entry.changeKind,
      porcelainCode: entry.porcelainCode,
      category: CANDIDATE_CATEGORIES.EXCLUDED,
      reasonCode: "incomplete_task",
      owner: distinctOwners.size === 1 ? [...distinctOwners][0] : null,
      completionEvidence: `미완료 상태: ${incDesc}`,
      verificationEvidence: null,
      reasons: [`연결된 작업이 아직 완료되지 않았습니다 (${incDesc}).`],
    };
  }

  // Contended shared core files without a single verified owner are unsafe to save -> EXCLUDED
  if (isContendedSharedCorePath(filePath) && distinctOwners.size !== 1) {
    return {
      path: filePath,
      changeKind: entry.changeKind,
      porcelainCode: entry.porcelainCode,
      category: CANDIDATE_CATEGORIES.EXCLUDED,
      reasonCode: "contended_core_file_unclear_owner",
      owner: null,
      completionEvidence: null,
      verificationEvidence: null,
      reasons: [
        "보호·경합 핵심 파일(app.ts/services/index.ts/heartbeat.ts/issues.ts/migration journal)이며 단일 담당자 완료·검증 근거가 없어 안전을 위해 제외합니다.",
      ],
    };
  }

  // 2. Check Category B (NEEDS_REVIEW) for multi-owner / mixed changes
  if (distinctOwners.size > 1) {
    const ownersList = [...distinctOwners].join(", ");
    return {
      path: filePath,
      changeKind: entry.changeKind,
      porcelainCode: entry.porcelainCode,
      category: CANDIDATE_CATEGORIES.NEEDS_REVIEW,
      reasonCode: "mixed_agent_changes_possible",
      owner: ownersList,
      completionEvidence: allClaims.map((c) => `${c.taskId}(${c.owner})`).join(", "),
      verificationEvidence: allClaims.map((c) => `${c.taskId}:${c.verificationStatus}`).join(", "),
      reasons: [`여러 AI 직원의 변경이 혼합되었을 가능성이 있습니다 (${ownersList}).`],
    };
  }

  // 3. Check Category A (SAVE_CANDIDATE) — strict 4-part requirement
  const verifiedTodayClaims = allClaims.filter(
    (c) =>
      c.completedToday === true &&
      c.verificationStatus === "passed" &&
      c.explicitFileLinkage === true &&
      typeof c.owner === "string" &&
      c.owner.trim().length > 0,
  );

  if (verifiedTodayClaims.length > 0 && distinctOwners.size === 1) {
    const primary = verifiedTodayClaims[0];
    return {
      path: filePath,
      changeKind: entry.changeKind,
      porcelainCode: entry.porcelainCode,
      category: CANDIDATE_CATEGORIES.SAVE_CANDIDATE,
      reasonCode: "verified_today_completed_work",
      owner: primary.owner,
      taskId: primary.taskId,
      completionEvidence: `${primary.taskId} (${primary.title}) — 당일 완료 확인`,
      verificationEvidence: primary.verificationDetail || "검증 통과(exitCode=0 / passed)",
      reasons: [
        `당일 완료(${primary.taskId}), 검증 성공(${primary.verificationDetail}), 담당자(${primary.owner}) 및 파일 연결 근거가 모두 확인되었습니다.`,
      ],
    };
  }

  // 4. Otherwise Category B (NEEDS_REVIEW) with specific diagnostic reason
  if (allClaims.length > 0) {
    const claim = allClaims[0];
    return {
      path: filePath,
      changeKind: entry.changeKind,
      porcelainCode: entry.porcelainCode,
      category: CANDIDATE_CATEGORIES.NEEDS_REVIEW,
      reasonCode: "insufficient_completion_or_verification_evidence",
      owner: claim.owner ?? null,
      taskId: claim.taskId ?? null,
      completionEvidence: `${claim.taskId} (status=${claim.status}, completedToday=${Boolean(claim.completedToday)})`,
      verificationEvidence: `${claim.verificationStatus} (${claim.verificationDetail || "근거 부족"})`,
      reasons: [
        `작업 기록(${claim.taskId})은 존재하나 당일 완료 확정 또는 검증 통과 증거가 부족합니다 (status=${claim.status}, verification=${claim.verificationStatus}).`,
      ],
    };
  }

  if (completedIssuesWithoutFiles.length > 0) {
    const issueList = completedIssuesWithoutFiles.map((i) => `${i.identifier}(${i.owner ?? "미상"})`).join(", ");
    return {
      path: filePath,
      changeKind: entry.changeKind,
      porcelainCode: entry.porcelainCode,
      category: CANDIDATE_CATEGORIES.NEEDS_REVIEW,
      reasonCode: "uncertain_issue_file_linkage",
      owner: null,
      completionEvidence: `당일 완료 이슈 존재(${issueList}) — 파일 연결 불확실`,
      verificationEvidence: null,
      reasons: [
        `당일 완료된 이슈(${issueList})가 있으나 이 파일과의 명시적 연결 근거가 없고, CLI 직접 수정 가능성이 있어 확인이 필요합니다.`,
      ],
    };
  }

  return {
    path: filePath,
    changeKind: entry.changeKind,
    porcelainCode: entry.porcelainCode,
    category: CANDIDATE_CATEGORIES.NEEDS_REVIEW,
    reasonCode: "cli_owner_unclear",
    owner: null,
    completionEvidence: null,
    verificationEvidence: null,
    reasons: [
      "작업 트리에 변경이 존재하나 당일 완료된 이슈·러너 검증 기록과 연결되지 않습니다 (CLI 작업 추정 / 소유자·완료·검증 근거 불명확 — 수정 시각만으로 자동 포함하지 않음).",
    ],
  };
}

/**
 * Main read-only collector entry point.
 * Can be called programmatically by Claude Code's JARVIS service or via CLI.
 */
export async function collectDailyGitSaveCandidates({
  repoRoot = process.cwd(),
  dateOrNow = new Date(),
  paperclipSnapshot = null,
  enableLiveApi = false,
  apiBaseUrl = "http://localhost:3100/api",
  companyId = null,
  fetchImpl = globalThis.fetch,
  requestedBy = "JARVIS",
} = {}) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const kstWindow = computeKstDayWindow(dateOrNow);

  // 1. Git read-only inspection
  const gitState = collectGitStateReadOnly(resolvedRepoRoot, kstWindow);

  // 2. Antigravity / CLI Task Runner inspection
  const runnerState = collectRunnerRecordsReadOnly(resolvedRepoRoot, kstWindow);

  // 3. Paperclip issues / agents / work products inspection
  let effectiveSnapshot = paperclipSnapshot;
  let apiFetchStatus = { ok: Boolean(paperclipSnapshot), reason: null };
  if (!effectiveSnapshot && enableLiveApi) {
    const fetched = await fetchPaperclipSnapshotReadOnly({
      apiBaseUrl,
      companyId,
      fetchImpl,
    });
    apiFetchStatus = { ok: fetched.ok, reason: fetched.reason };
    effectiveSnapshot = fetched.snapshot;
  }
  const paperclipState = analyzePaperclipRecords(effectiveSnapshot, kstWindow);

  // 4. Build runner claims & active conflict maps by normalized file path
  const runnerClaimsByFile = new Map();
  const runnerConflictsByFile = new Map();

  for (const run of runnerState.runsToday) {
    for (const filePath of run.changedFiles) {
      const key = normalizePathKey(filePath);
      const list = runnerClaimsByFile.get(key) ?? [];
      list.push({
        source: "antigravity_runner",
        taskId: run.taskId,
        title: run.taskName,
        owner: run.owner,
        status: run.status,
        completedToday: run.completedInKstWindow && run.status === "DONE",
        verificationStatus: run.verificationPassed
          ? "passed"
          : run.status === "FAILED" || (typeof run.verificationExitCode === "number" && run.verificationExitCode !== 0)
            ? "failed"
            : "unknown",
        verificationExitCode: run.verificationExitCode,
        verificationDetail: run.verificationPassed
          ? `Runner verification passed (${run.verificationCommand ?? "verified"}, exitCode=0, scopeCompliance=true)`
          : `Runner status=${run.status}, exitCode=${run.verificationExitCode ?? "N/A"}`,
        explicitFileLinkage: true,
      });
      runnerClaimsByFile.set(key, list);
    }
  }

  for (const activeRun of runnerState.activeRuns) {
    for (const allowedPrefix of activeRun.allowedPaths) {
      const normPrefix = normalizePathKey(allowedPrefix);
      for (const entry of gitState.workingTreeEntries) {
        const normFile = normalizePathKey(entry.path);
        if (normFile === normPrefix || normFile.startsWith(`${normPrefix}/`)) {
          const list = runnerConflictsByFile.get(normFile) ?? [];
          list.push({
            source: "antigravity_runner",
            taskId: activeRun.taskId,
            owner: activeRun.owner,
            status: "IN_PROGRESS",
          });
          runnerConflictsByFile.set(normFile, list);
        }
      }
    }
  }

  const completedIssuesWithoutFiles = paperclipState.completedIssuesToday.filter(
    (issue) => !Array.isArray(issue.linkedFiles) || issue.linkedFiles.length === 0,
  );

  // 5. Classify every working-tree file
  const saveCandidates = [];
  const needsReview = [];
  const excluded = [];

  for (const entry of gitState.workingTreeEntries) {
    const key = normalizePathKey(entry.path);
    const classification = classifyWorkingTreeEntry({
      repoRoot: resolvedRepoRoot,
      entry,
      runnerClaims: runnerClaimsByFile.get(key) ?? [],
      runnerActiveConflicts: runnerConflictsByFile.get(key) ?? [],
      paperclipClaims: paperclipState.taskClaimsByFile.get(key) ?? [],
      paperclipActiveConflicts: paperclipState.activeFileConflicts.get(key) ?? [],
      completedIssuesWithoutFiles,
    });

    if (classification.category === CANDIDATE_CATEGORIES.SAVE_CANDIDATE) {
      saveCandidates.push(classification);
    } else if (classification.category === CANDIDATE_CATEGORIES.NEEDS_REVIEW) {
      needsReview.push(classification);
    } else {
      excluded.push(classification);
    }
  }

  // 6. Track uninspectable sources across all NEXORA agents and CLIs
  const uninspectableSources = [];
  if (!paperclipState.inspectable) {
    uninspectableSources.push({
      source: "paperclip_control_plane_db_api",
      target: "NEXORA 전체 AI 직원 이슈·워크프로덕트·하트비트 런 기록",
      reason: apiFetchStatus.reason || paperclipState.reason,
    });
  }
  if (!runnerState.inspectable) {
    uninspectableSources.push({
      source: "antigravity_task_runner_logs",
      target: "Antigravity CLI 러너(.agents/antigravity-runner/runs) 실행 기록",
      reason: runnerState.reason,
    });
  } else if (runnerState.runsToday.length === 0 && runnerState.activeRuns.length === 0) {
    uninspectableSources.push({
      source: "antigravity_task_runner_today",
      target: `Antigravity CLI 러너 당일(${kstWindow.dateKst}) 실행 기록`,
      reason: "당일(KST) 생성된 러너 report.json 기록이 없음",
    });
  }

  // Interactive CLI sessions (Claude Code CLI, Codex CLI, direct shell edits) do not write
  // per-file completion/verification manifests into the repo automatically unless tied to an issue/runner.
  uninspectableSources.push({
    source: "interactive_cli_sessions",
    target: "Claude Code CLI / Codex CLI / 로컬 터미널 직접 편집 세션",
    reason:
      "대화형 CLI 세션은 저장소 내부에 파일별 완료·검증 구조화 로그를 자동 기록하지 않으므로, 이슈·러너 근거가 없는 작업 트리 파일은 자동 저장 후보(A)에 넣지 않고 확인 필요(B) 또는 제외(C)로 분류함",
  });

  // 7. Build hand-off candidate for `scripts/operations/git-save-prepare.mjs`
  const blockedReasons = [];
  if (gitState.branch !== ALLOWED_BRANCH) {
    blockedReasons.push(`현재 브랜치(${gitState.branch})가 허용 브랜치(${ALLOWED_BRANCH})가 아님`);
  }
  if (gitState.hasStagedFiles) {
    blockedReasons.push(`Git 인덱스에 이미 스테이징된 파일(${gitState.stagedFiles.length}개)이 존재함`);
  }
  if (!gitState.isAncestorOfHead && gitState.remoteHeadSha) {
    blockedReasons.push("로컬 HEAD가 origin/master의 fast-forward 조상을 포함하지 않음 (분기 상태)");
  }
  if (saveCandidates.length === 0) {
    blockedReasons.push("당일 완료·검증·단일 소유권이 모두 입증된 A(저장 후보) 파일이 0개임");
  }

  let prepareRequestCandidate = null;
  let prepareRequestValidationErrors = [];
  if (saveCandidates.length > 0) {
    const candidatePaths = saveCandidates.map((item) => item.path);
    const owners = [...new Set(saveCandidates.map((item) => item.owner).filter(Boolean))];
    const tasks = [...new Set(saveCandidates.map((item) => item.taskId).filter(Boolean))];
    prepareRequestCandidate = {
      approvedPaths: candidatePaths,
      verifyProfile: Object.keys(VERIFY_PROFILES)[0] ?? "git-save-self-test",
      commitMessage: `feat: save verified NEXORA work for ${kstWindow.dateKst} (${tasks.join(", ") || "verified tasks"})`,
      requestedBy: requestedBy || owners[0] || "JARVIS",
      reason: `${kstWindow.dateKst} KST 당일 완료 및 검증 통과가 확인된 작업 파일 ${candidatePaths.length}개 (${tasks.join(", ") || owners.join(", ")})`,
    };
    prepareRequestValidationErrors = validatePrepareRequest(prepareRequestCandidate, {
      repoRoot: resolvedRepoRoot,
    });
    if (prepareRequestValidationErrors.length > 0) {
      blockedReasons.push(`git-save-prepare 요청 검증 오류: ${prepareRequestValidationErrors.join("; ")}`);
    }
  }

  const readyForPrepare =
    saveCandidates.length > 0 &&
    blockedReasons.length === 0 &&
    prepareRequestValidationErrors.length === 0;

  return {
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    collectedAtKst: formatKstTimestamp(new Date()),
    readOnlyGuaranteed: true,
    kstWindow,
    repoState: {
      repoRoot: resolvedRepoRoot,
      branch: gitState.branch,
      headSha: gitState.headSha,
      remoteHeadSha: gitState.remoteHeadSha,
      expectedRemoteUrl: ALLOWED_REMOTE_URLS[0],
      isAncestorOfHead: gitState.isAncestorOfHead,
      hasStagedFiles: gitState.hasStagedFiles,
      stagedFiles: gitState.stagedFiles,
    },
    todayCommits: gitState.todayCommits,
    completedIssuesToday: paperclipState.completedIssuesToday,
    incompleteOrActiveIssues: paperclipState.incompleteOrActiveIssues,
    runnerRunsToday: runnerState.runsToday,
    uninspectableSources,
    classifications: {
      saveCandidates,
      needsReview,
      excluded,
    },
    summaryCounts: {
      totalWorkingTreeChanges: gitState.workingTreeEntries.length,
      saveCandidateCount: saveCandidates.length,
      needsReviewCount: needsReview.length,
      excludedCount: excluded.length,
      todayCommitCount: gitState.todayCommits.length,
      completedIssueCount: paperclipState.completedIssuesToday.length,
      runnerRunCount: runnerState.runsToday.length,
      uninspectableSourceCount: uninspectableSources.length,
    },
    gitSaveHandOff: {
      readyForPrepare,
      autoGeneratedManifest: null,
      prepareRequestCandidate,
      prepareRequestValidationErrors,
      blockedReasons,
      nextStepCommand: readyForPrepare
        ? "node scripts/operations/git-save-prepare.mjs --request <request.json> --output <manifest.json>"
        : null,
      ceoGateCommand: readyForPrepare
        ? "node scripts/operations/git-save.mjs --manifest <manifest.json>"
        : null,
    },
  };
}

/**
 * Renders the CEO-facing Korean Markdown investigation report from the collected result.
 */
export function renderDailyGitSaveReportMarkdown(result) {
  const {
    kstWindow,
    repoState,
    todayCommits,
    completedIssuesToday,
    runnerRunsToday,
    uninspectableSources,
    classifications,
    summaryCounts,
    gitSaveHandOff,
  } = result;

  const lines = [
    `# NEXORA 당일 전체 작업 GitHub 저장 후보 통합 조사 보고서 (${kstWindow.dateKst} KST)`,
    "",
    `- **조사 기준 일시 (KST)**: \`${kstWindow.startKst}\` ~ \`${kstWindow.endKst}\` (직전)`,
    `- **생성 시각 (KST)**: \`${result.collectedAtKst}\``,
    `- **읽기 전용 보장**: \`READ-ONLY\` (Git 스테이징·커밋·푸시·파일 변조 0건)`,
    `- **저장소 루트**: \`${repoState.repoRoot}\``,
    `- **현재 브랜치 / HEAD**: \`${repoState.branch}\` / \`${repoState.headSha}\``,
    `- **원격 origin/master**: \`${repoState.remoteHeadSha ?? "확인 불가"}\` (fast-forward 가능: \`${repoState.isAncestorOfHead ? "예" : "아니오"}\`)`,
    "",
    "---",
    "",
    "## 1. 핵심 요약 (CEO 한눈에 보기)",
    "",
    "| 항목 | 건수 | 설명 |",
    "|---|---:|---|",
    `| 당일 Git 커밋 (KST) | **${summaryCounts.todayCommitCount}건** | 이미 로컬 커밋(및 원격 푸시)된 당일 이력 |`,
    `| 당일 완료 확인 이슈 / 러너 작업 | **${summaryCounts.completedIssueCount + summaryCounts.runnerRunCount}건** | Paperclip 이슈 ${summaryCounts.completedIssueCount}건 / 러너 ${summaryCounts.runnerRunCount}건 |`,
    `| 현재 작업 트리 미저장 변경 전체 | **${summaryCounts.totalWorkingTreeChanges}개** | 수정·추가·삭제·미추적 파일 전체 |`,
    `| **A. 저장 후보 (SAVE_CANDIDATE)** | **${summaryCounts.saveCandidateCount}개** | 당일 완료 + 검증 통과 + 단일 담당자 연결 + 무충돌 |`,
    `| **B. 확인 필요 (NEEDS_REVIEW)** | **${summaryCounts.needsReviewCount}개** | CLI 소유자 불명확 / 검증 근거 부족 / 혼합 가능성 |`,
    `| **C. 제외 (EXCLUDED)** | **${summaryCounts.excludedCount}개** | 진행 중 / 검증 실패 / 충돌 / 보호·민감·임시 파일 |`,
    `| 조사 불가(제한) 기록원 | **${summaryCounts.uninspectableSourceCount}건** | 서버 미연결 또는 CLI 비구조화 세션 |`,
    "",
    "---",
    "",
    "## 2. 당일 Git 커밋 이력 (이미 커밋된 작업)",
    "",
  ];

  if (todayCommits.length === 0) {
    lines.push("- 당일(KST) 생성된 Git 커밋이 없습니다.", "");
  } else {
    lines.push("| 커밋 SHA | 시각 (KST) | 작성자 | 원격 푸시 여부 | 커밋 메시지 | 변경 파일 수 |");
    lines.push("|---|---|---|---|---|---:|");
    for (const c of todayCommits) {
      lines.push(
        `| \`${c.shortSha}\` | \`${c.committedAtKst}\` | ${c.authorName} | ${c.pushedToRemote ? "푸시 완료" : "로컬 전용"} | ${c.subject} | ${c.changedFiles.length}개 |`,
      );
    }
    lines.push("");
  }

  lines.push("---", "", "## 3. 당일 완료된 이슈 및 러너 검증 기록", "");
  if (completedIssuesToday.length === 0 && runnerRunsToday.length === 0) {
    lines.push("- 구조화된 당일 완료 이슈 또는 Antigravity 러너 완료 기록이 조회되지 않았습니다.", "");
  } else {
    for (const issue of completedIssuesToday) {
      lines.push(
        `- **[이슈 ${issue.identifier}]** ${issue.title} — 담당: \`${issue.owner ?? "미상"}\`, 완료: \`${issue.completedAtKst ?? "미상"}\`, 검증: \`${issue.verificationStatus}\` (${issue.verificationDetail}), 연결 파일: ${issue.linkedFiles.length}개`,
      );
    }
    for (const run of runnerRunsToday) {
      lines.push(
        `- **[러너 ${run.taskId}]** ${run.taskName} — 담당: \`${run.owner}\`, 상태: \`${run.status}\`, 검증 통과: \`${run.verificationPassed}\`, 변경 파일: ${run.changedFiles.length}개`,
      );
    }
    lines.push("");
  }

  lines.push("---", "", "## 4. 작업 트리 파일 3단계 분류 결과", "");

  lines.push(`### A. 저장 후보 (SAVE_CANDIDATE) — ${classifications.saveCandidates.length}개`, "");
  if (classifications.saveCandidates.length === 0) {
    lines.push("- 자동 저장 후보 요건(당일 완료 + 검증 성공 + 담당자·파일 연결 + 무충돌)을 모두 충족하는 미커밋 파일이 없습니다.", "");
  } else {
    lines.push("| 파일 경로 | 상태 | 담당자 | 완료 근거 | 검증 근거 |");
    lines.push("|---|---|---|---|---|");
    for (const item of classifications.saveCandidates) {
      lines.push(
        `| \`${item.path}\` | \`${item.porcelainCode}\` | ${item.owner ?? "미상"} | ${item.completionEvidence ?? "-"} | ${item.verificationEvidence ?? "-"} |`,
      );
    }
    lines.push("");
  }

  lines.push(`### B. 확인 필요 (NEEDS_REVIEW) — ${classifications.needsReview.length}개`, "");
  if (classifications.needsReview.length === 0) {
    lines.push("- 확인 필요(B)로 분류된 파일이 없습니다.", "");
  } else {
    lines.push("| 파일 경로 | 상태 | 추정 담당자 | 분류 사유 코드 | 상세 사유 |");
    lines.push("|---|---|---|---|---|");
    for (const item of classifications.needsReview) {
      lines.push(
        `| \`${item.path}\` | \`${item.porcelainCode}\` | ${item.owner ?? "불명확(CLI 추정)"} | \`${item.reasonCode}\` | ${item.reasons.join(" ")} |`,
      );
    }
    lines.push("");
  }

  lines.push(`### C. 제외 (EXCLUDED) — ${classifications.excluded.length}개`, "");
  if (classifications.excluded.length === 0) {
    lines.push("- 제외(C)로 분류된 파일이 없습니다.", "");
  } else {
    lines.push("| 파일 경로 | 상태 | 분류 사유 코드 | 제외 근거 |");
    lines.push("|---|---|---|---|");
    for (const item of classifications.excluded) {
      lines.push(`| \`${item.path}\` | \`${item.porcelainCode}\` | \`${item.reasonCode}\` | ${item.reasons.join(" ")} |`);
    }
    lines.push("");
  }

  lines.push("---", "", "## 5. 조사 불가능(제한) 자료 및 사유", "");
  if (uninspectableSources.length === 0) {
    lines.push("- 모든 자료원이 정상 조회되었습니다.", "");
  } else {
    for (const src of uninspectableSources) {
      lines.push(`- **${src.target}** (\`${src.source}\`): ${src.reason}`);
    }
    lines.push("");
  }

  lines.push("---", "", "## 6. 기존 Git Save Gate 전달 후보 정보", "");
  lines.push(`- **즉시 요청서(prepare) 전달 가능 여부**: \`${gitSaveHandOff.readyForPrepare ? "YES" : "NO"}\``);
  if (gitSaveHandOff.blockedReasons.length > 0) {
    lines.push("- **보류/차단 사유**:");
    for (const reason of gitSaveHandOff.blockedReasons) {
      lines.push(`  - ${reason}`);
    }
  }
  if (gitSaveHandOff.prepareRequestCandidate) {
    lines.push("", "### `git-save-prepare.mjs` 전달용 요청 후보 JSON (`prepareRequestCandidate`)", "");
    lines.push("```json", JSON.stringify(gitSaveHandOff.prepareRequestCandidate, null, 2), "```");
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Validates that an output file path is inside an approved non-source output location
 * (either inside `<repoRoot>/scratch/` or an explicit external scratch/artifact directory)
 * and never overwrites a tracked source file or `.git/` internal file.
 */
export function validateSafeReportOutputPath(repoRoot, targetPath) {
  if (!targetPath || typeof targetPath !== "string" || !targetPath.trim()) {
    throw new Error("Output path must be a non-empty string");
  }
  const resolvedRepo = path.resolve(repoRoot);
  const resolvedTarget = path.resolve(resolvedRepo, targetPath);
  const relToRepo = path.relative(resolvedRepo, resolvedTarget);
  const normalizedRel = toPosixPath(relToRepo);

  if (!relToRepo.startsWith("..") && !path.isAbsolute(relToRepo)) {
    if (normalizedRel.startsWith(".git/") || normalizedRel === ".git") {
      throw new Error(`Refusing to write output inside .git: ${resolvedTarget}`);
    }
    if (!normalizedRel.startsWith("scratch/")) {
      throw new Error(
        `In-repo output path must be inside the gitignored 'scratch/' directory to protect source files: ${normalizedRel}`,
      );
    }
  }
  return resolvedTarget;
}

export function writeCollectorOutputs({ repoRoot, result, jsonOutPath = null, reportOutPath = null }) {
  const written = { jsonPath: null, reportPath: null };
  if (jsonOutPath) {
    const safeJsonPath = validateSafeReportOutputPath(repoRoot, jsonOutPath);
    mkdirSync(path.dirname(safeJsonPath), { recursive: true });
    writeFileSync(safeJsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    written.jsonPath = safeJsonPath;
  }
  if (reportOutPath) {
    const safeReportPath = validateSafeReportOutputPath(repoRoot, reportOutPath);
    mkdirSync(path.dirname(safeReportPath), { recursive: true });
    const markdown = renderDailyGitSaveReportMarkdown(result);
    writeFileSync(safeReportPath, markdown, "utf8");
    written.reportPath = safeReportPath;
  }
  return written;
}

export function parseCollectorArgs(argv) {
  const args = {
    repoRoot: process.cwd(),
    date: null,
    snapshotPath: null,
    enableLiveApi: false,
    apiBaseUrl: "http://localhost:3100/api",
    companyId: null,
    jsonOut: null,
    reportOut: null,
    writeDefaultOutput: false,
    jsonStdout: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo-root") args.repoRoot = argv[++i] ?? args.repoRoot;
    else if (arg === "--date") args.date = argv[++i] ?? null;
    else if (arg === "--snapshot") args.snapshotPath = argv[++i] ?? null;
    else if (arg === "--live-api") args.enableLiveApi = true;
    else if (arg === "--api-base") args.apiBaseUrl = argv[++i] ?? args.apiBaseUrl;
    else if (arg === "--company-id") args.companyId = argv[++i] ?? null;
    else if (arg === "--json-out") args.jsonOut = argv[++i] ?? null;
    else if (arg === "--report-out") args.reportOut = argv[++i] ?? null;
    else if (arg === "--write-default-output") args.writeDefaultOutput = true;
    else if (arg === "--json") args.jsonStdout = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  console.log(
    [
      "NEXORA Daily Git Save Candidate Collector (READ-ONLY)",
      "",
      "Usage:",
      "  node scripts/operations/git-save-collect-daily.mjs [options]",
      "",
      "Options:",
      "  --date <YYYY-MM-DD>       Target KST date (defaults to today in Asia/Seoul)",
      "  --repo-root <path>        Repository root path",
      "  --snapshot <file.json>    Optional Paperclip issue/agent snapshot JSON file",
      "  --live-api                Attempt read-only GET against local Paperclip server",
      "  --json                    Print structured JSON result to stdout",
      "  --json-out <path>         Write candidate JSON to scratch/ or external output path",
      "  --report-out <path>       Write CEO Markdown report to scratch/ or external output path",
      "  --write-default-output    Write both JSON and Markdown report into scratch/",
      "  --help, -h                Show this help",
    ].join("\n"),
  );
}

async function main() {
  let args;
  try {
    args = parseCollectorArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[git-save-collect-daily] Argument error: ${err.message}`);
    usage();
    process.exitCode = 2;
    return;
  }

  if (args.help) {
    usage();
    return;
  }

  let paperclipSnapshot = null;
  if (args.snapshotPath) {
    const resolvedSnap = path.resolve(args.repoRoot, args.snapshotPath);
    paperclipSnapshot = JSON.parse(readFileSync(resolvedSnap, "utf8"));
  }

  const result = await collectDailyGitSaveCandidates({
    repoRoot: args.repoRoot,
    dateOrNow: args.date ?? new Date(),
    paperclipSnapshot,
    enableLiveApi: args.enableLiveApi,
    apiBaseUrl: args.apiBaseUrl,
    companyId: args.companyId,
  });

  let jsonOut = args.jsonOut;
  let reportOut = args.reportOut;
  if (args.writeDefaultOutput) {
    const dateTag = result.kstWindow.dateKst;
    jsonOut = jsonOut ?? `scratch/git-save-daily-candidates-${dateTag}.json`;
    reportOut = reportOut ?? `scratch/git-save-daily-report-${dateTag}.md`;
  }

  const written = writeCollectorOutputs({
    repoRoot: args.repoRoot,
    result,
    jsonOutPath: jsonOut,
    reportOutPath: reportOut,
  });

  if (args.jsonStdout) {
    console.log(JSON.stringify({ ...result, writtenOutputs: written }, null, 2));
  } else {
    console.log(renderDailyGitSaveReportMarkdown(result));
    if (written.jsonPath || written.reportPath) {
      console.log("\n---");
      if (written.reportPath) console.log(`CEO Report saved to: ${written.reportPath}`);
      if (written.jsonPath) console.log(`Candidate JSON saved to: ${written.jsonPath}`);
    }
  }
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  main().catch((err) => {
    console.error(`[git-save-collect-daily] FAILED: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
