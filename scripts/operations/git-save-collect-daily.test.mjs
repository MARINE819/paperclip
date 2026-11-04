import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ALLOWED_BRANCH,
  ALLOWED_REMOTES,
  VERIFY_PROFILES,
  validateManifest,
} from "./git-save.mjs";
import { validatePrepareRequest } from "./git-save-prepare.mjs";
import {
  CANDIDATE_CATEGORIES,
  KST_TIMEZONE,
  collectDailyGitSaveCandidates,
  computeKstDayWindow,
  formatKstTimestamp,
  isWithinKstDayWindow,
  parseCollectorArgs,
  parsePorcelainV1Z,
  renderDailyGitSaveReportMarkdown,
  validateSafeReportOutputPath,
  writeCollectorOutputs,
} from "./git-save-collect-daily.mjs";

const COLLECTOR_SCRIPT_PATH = fileURLToPath(new URL("./git-save-collect-daily.mjs", import.meta.url));
const GIT_SAVE_SCRIPT_PATH = fileURLToPath(new URL("./git-save.mjs", import.meta.url));
const GIT_SAVE_PREPARE_PATH = fileURLToPath(new URL("./git-save-prepare.mjs", import.meta.url));

function git(args, cwd, envOverrides = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, ...envOverrides },
  }).trim();
}

function initThrowawayRepoWithRemote() {
  const localDir = mkdtempSync(path.join(os.tmpdir(), "git-save-collect-local-"));
  const remoteDir = mkdtempSync(path.join(os.tmpdir(), "git-save-collect-remote-"));
  git(["init", "--bare", "--initial-branch=master"], remoteDir);
  git(["init", "--initial-branch=master"], localDir);
  git(["config", "user.email", "test@nexora.local"], localDir);
  git(["config", "user.name", "NEXORA Test"], localDir);

  writeFileSync(path.join(localDir, "README.md"), "# NEXORA Fixture\n", "utf8");
  git(
    ["add", "README.md"],
    localDir,
    {
      GIT_AUTHOR_DATE: "2026-10-30T12:00:00+09:00",
      GIT_COMMITTER_DATE: "2026-10-30T12:00:00+09:00",
    },
  );
  git(
    ["commit", "-m", "chore: initial commit"],
    localDir,
    {
      GIT_AUTHOR_DATE: "2026-10-30T12:00:00+09:00",
      GIT_COMMITTER_DATE: "2026-10-30T12:00:00+09:00",
    },
  );
  git(["remote", "add", "origin", remoteDir], localDir);
  git(["push", "origin", "master"], localDir);
  git(["fetch", "origin"], localDir);
  return { localDir, remoteDir };
}

function cleanupDirs(...dirs) {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. 한국 날짜 경계 처리 (Asia/Seoul 00:00 ~ 다음 날 00:00 직전)
// ---------------------------------------------------------------------------

test("1. KST date boundary: computeKstDayWindow and isWithinKstDayWindow enforce exact [00:00:00.000+09:00, next 00:00:00.000+09:00) bounds", () => {
  const win = computeKstDayWindow("2026-11-01");
  assert.equal(win.timezone, KST_TIMEZONE);
  assert.equal(win.dateKst, "2026-11-01");
  assert.equal(win.nextDateKst, "2026-11-02");
  assert.equal(win.startKst, "2026-11-01T00:00:00.000+09:00");
  assert.equal(win.endKst, "2026-11-02T00:00:00.000+09:00");
  assert.equal(win.startIso, "2026-10-31T15:00:00.000Z");
  assert.equal(win.endIso, "2026-11-01T15:00:00.000Z");
  assert.equal(win.endMs - win.startMs, 24 * 60 * 60 * 1000);

  // 1ms before midnight KST on 2026-11-01 -> false
  assert.equal(isWithinKstDayWindow("2026-10-31T23:59:59.999+09:00", win), false);
  assert.equal(isWithinKstDayWindow("2026-10-31T14:59:59.999Z", win), false);

  // Exact midnight KST on 2026-11-01 -> true
  assert.equal(isWithinKstDayWindow("2026-11-01T00:00:00.000+09:00", win), true);
  assert.equal(isWithinKstDayWindow("2026-10-31T15:00:00.000Z", win), true);

  // Last millisecond of 2026-11-01 KST -> true
  assert.equal(isWithinKstDayWindow("2026-11-01T23:59:59.999+09:00", win), true);
  assert.equal(isWithinKstDayWindow("2026-11-01T14:59:59.999Z", win), true);

  // Exact midnight of next day 2026-11-02 KST -> false (exclusive upper bound)
  assert.equal(isWithinKstDayWindow("2026-11-02T00:00:00.000+09:00", win), false);
  assert.equal(isWithinKstDayWindow("2026-11-01T15:00:00.000Z", win), false);
});

test("1b. KST date boundary: derives correct KST date when given a UTC Date near midnight", () => {
  // 2026-10-31T16:30:00.000Z is 2026-11-01T01:30:00.000+09:00 in Korea
  const win = computeKstDayWindow(new Date("2026-10-31T16:30:00.000Z"));
  assert.equal(win.dateKst, "2026-11-01");
  assert.equal(formatKstTimestamp("2026-10-31T16:30:00.000Z"), "2026-11-01T01:30:00.000+09:00");
});

// ---------------------------------------------------------------------------
// 2. 여러 AI 직원의 작업 수집 & 혼합 변경 감지
// ---------------------------------------------------------------------------

test("2. Multi-agent collection: collects verified completed work from multiple AI employees and flags mixed-owner files as NEEDS_REVIEW", async () => {
  const { localDir, remoteDir } = initThrowawayRepoWithRemote();
  try {
    mkdirSync(path.join(localDir, "ui", "src"), { recursive: true });
    mkdirSync(path.join(localDir, "server", "src"), { recursive: true });
    writeFileSync(path.join(localDir, "ui", "src", "WidgetA.tsx"), "export const A = 1;\n", "utf8");
    writeFileSync(path.join(localDir, "server", "src", "serviceB.ts"), "export const B = 2;\n", "utf8");
    writeFileSync(path.join(localDir, "ui", "src", "SharedC.tsx"), "export const C = 3;\n", "utf8");

    const snapshot = {
      agents: [
        { id: "ag-1", name: "Antigravity" },
        { id: "ag-2", name: "Claude Code" },
      ],
      issues: [
        {
          id: "iss-1",
          identifier: "NEX-201",
          title: "Implement WidgetA",
          status: "done",
          assigneeAgentId: "ag-1",
          completedAt: "2026-11-01T10:00:00+09:00",
          verificationStatus: "passed",
          verificationDetail: "Vitest 12/12 PASS",
          changedFiles: ["ui/src/WidgetA.tsx", "ui/src/SharedC.tsx"],
        },
        {
          id: "iss-2",
          identifier: "NEX-202",
          title: "Implement serviceB",
          status: "done",
          assigneeAgentId: "ag-2",
          completedAt: "2026-11-01T14:00:00+09:00",
          verificationStatus: "passed",
          verificationDetail: "Server test 8/8 PASS",
          changedFiles: ["server/src/serviceB.ts", "ui/src/SharedC.tsx"],
        },
      ],
      liveRuns: [],
    };

    const result = await collectDailyGitSaveCandidates({
      repoRoot: localDir,
      dateOrNow: "2026-11-01",
      paperclipSnapshot: snapshot,
    });

    const candidatePaths = result.classifications.saveCandidates.map((c) => c.path).sort();
    assert.deepEqual(candidatePaths, ["server/src/serviceB.ts", "ui/src/WidgetA.tsx"]);

    const mixedItem = result.classifications.needsReview.find((c) => c.path === "ui/src/SharedC.tsx");
    assert.ok(mixedItem, "SharedC.tsx touched by two different AI employees must be in NEEDS_REVIEW");
    assert.equal(mixedItem.reasonCode, "mixed_agent_changes_possible");
  } finally {
    cleanupDirs(localDir, remoteDir);
  }
});

// ---------------------------------------------------------------------------
// 3. Git 커밋과 작업 트리 변경 조사
// ---------------------------------------------------------------------------

test("3. Git commits & working tree inspection: collects only today's KST commits and all working-tree changes", async () => {
  const { localDir, remoteDir } = initThrowawayRepoWithRemote();
  try {
    // Commit yesterday in KST (2026-10-31T23:50:00+09:00) -> should NOT be in todayCommits for 2026-11-01
    writeFileSync(path.join(localDir, "yesterday.txt"), "yesterday\n", "utf8");
    git(["add", "yesterday.txt"], localDir);
    git(["commit", "-m", "feat: yesterday work"], localDir, {
      GIT_AUTHOR_DATE: "2026-10-31T23:50:00+09:00",
      GIT_COMMITTER_DATE: "2026-10-31T23:50:00+09:00",
    });

    // Commit today in KST (2026-11-01T09:15:00+09:00) -> SHOULD be in todayCommits
    writeFileSync(path.join(localDir, "today-committed.txt"), "committed today\n", "utf8");
    git(["add", "today-committed.txt"], localDir);
    git(["commit", "-m", "feat: today morning commit"], localDir, {
      GIT_AUTHOR_DATE: "2026-11-01T09:15:00+09:00",
      GIT_COMMITTER_DATE: "2026-11-01T09:15:00+09:00",
    });

    // Working-tree modified & untracked changes
    writeFileSync(path.join(localDir, "README.md"), "# Modified README\n", "utf8");
    writeFileSync(path.join(localDir, "untracked-new.txt"), "new content\n", "utf8");

    const result = await collectDailyGitSaveCandidates({
      repoRoot: localDir,
      dateOrNow: "2026-11-01",
    });

    assert.equal(result.todayCommits.length, 1);
    assert.equal(result.todayCommits[0].subject, "feat: today morning commit");
    assert.equal(result.todayCommits[0].pushedToRemote, false);
    assert.deepEqual(
      result.todayCommits[0].changedFiles.map((f) => f.path),
      ["today-committed.txt"],
    );
    assert.equal(result.summaryCounts.totalWorkingTreeChanges, 2);
  } finally {
    cleanupDirs(localDir, remoteDir);
  }
});

// ---------------------------------------------------------------------------
// 4. CLI 소유권 불명확 파일의 자동 포함 방지 (mtime만으로 확정 금지)
// ---------------------------------------------------------------------------

test("4. Unattributed CLI files: never auto-includes files based on today's mtime without owner/completion/verification proof", async () => {
  const { localDir, remoteDir } = initThrowawayRepoWithRemote();
  try {
    const cliFile = path.join(localDir, "src", "cli-mystery.ts");
    mkdirSync(path.dirname(cliFile), { recursive: true });
    writeFileSync(cliFile, "export const mystery = true;\n", "utf8");
    const todayKstTime = new Date("2026-11-01T15:00:00+09:00");
    utimesSync(cliFile, todayKstTime, todayKstTime);

    const result = await collectDailyGitSaveCandidates({
      repoRoot: localDir,
      dateOrNow: "2026-11-01",
    });

    assert.equal(result.classifications.saveCandidates.length, 0);
    assert.equal(result.gitSaveHandOff.readyForPrepare, false);
    assert.equal(result.gitSaveHandOff.prepareRequestCandidate, null);

    const reviewItem = result.classifications.needsReview.find((c) => c.path === "src/cli-mystery.ts");
    assert.ok(reviewItem, "Unattributed CLI file must be classified as NEEDS_REVIEW");
    assert.equal(reviewItem.reasonCode, "cli_owner_unclear");
  } finally {
    cleanupDirs(localDir, remoteDir);
  }
});

// ---------------------------------------------------------------------------
// 5. 검증 실패·미실행 작업 제외
// ---------------------------------------------------------------------------

test("5. Verification failed or unexecuted work: strictly excludes files with failed or unexecuted tests", async () => {
  const { localDir, remoteDir } = initThrowawayRepoWithRemote();
  try {
    mkdirSync(path.join(localDir, "src"), { recursive: true });
    writeFileSync(path.join(localDir, "src", "failed-feature.ts"), "export const bad = 1;\n", "utf8");
    writeFileSync(path.join(localDir, "src", "untested-feature.ts"), "export const untested = 2;\n", "utf8");

    const snapshot = {
      agents: [{ id: "ag-1", name: "Antigravity" }],
      issues: [
        {
          id: "iss-fail",
          identifier: "NEX-301",
          title: "Feature with failing test",
          status: "done",
          assigneeAgentId: "ag-1",
          completedAt: "2026-11-01T11:00:00+09:00",
          verificationStatus: "failed",
          verificationDetail: "Vitest 1 failed",
          changedFiles: ["src/failed-feature.ts"],
        },
        {
          id: "iss-unexec",
          identifier: "NEX-302",
          title: "Feature with unexecuted test",
          status: "done",
          assigneeAgentId: "ag-1",
          completedAt: "2026-11-01T12:00:00+09:00",
          verificationStatus: "unexecuted",
          verificationDetail: "Tests were not run",
          changedFiles: ["src/untested-feature.ts"],
        },
      ],
      liveRuns: [],
    };

    const result = await collectDailyGitSaveCandidates({
      repoRoot: localDir,
      dateOrNow: "2026-11-01",
      paperclipSnapshot: snapshot,
    });

    assert.equal(result.classifications.saveCandidates.length, 0);
    const excludedPaths = result.classifications.excluded.map((e) => e.path).sort();
    assert.deepEqual(excludedPaths, ["src/failed-feature.ts", "src/untested-feature.ts"]);
    for (const item of result.classifications.excluded) {
      assert.equal(item.reasonCode, "verification_failed_or_unexecuted");
    }
  } finally {
    cleanupDirs(localDir, remoteDir);
  }
});

// ---------------------------------------------------------------------------
// 6. 충돌 파일 및 진행 중 작업 파일 제외
// ---------------------------------------------------------------------------

test("6. Conflicted & in-progress files: excludes Git unmerged entries and files tied to active in-progress tasks", async () => {
  const { localDir, remoteDir } = initThrowawayRepoWithRemote();
  try {
    // Test porcelain parser for UU unmerged entry directly
    const parsedConflict = parsePorcelainV1Z("UU src/conflicted.ts\0");
    assert.equal(parsedConflict.length, 1);
    assert.equal(parsedConflict[0].isConflicted, true);
    assert.equal(parsedConflict[0].changeKind, "conflicted");

    // In-progress task file + contended shared core file without owner
    mkdirSync(path.join(localDir, "server", "src"), { recursive: true });
    writeFileSync(path.join(localDir, "server", "src", "active-work.ts"), "export const wip = true;\n", "utf8");
    writeFileSync(path.join(localDir, "server", "src", "app.ts"), "export const app = true;\n", "utf8");

    const snapshot = {
      agents: [{ id: "ag-claude", name: "Claude Code" }],
      issues: [
        {
          id: "iss-wip",
          identifier: "NEX-401",
          title: "WIP backend service",
          status: "in_progress",
          assigneeAgentId: "ag-claude",
          changedFiles: ["server/src/active-work.ts"],
        },
      ],
      liveRuns: [{ id: "run-1", agentId: "ag-claude", issueId: "iss-wip", status: "running" }],
    };

    const result = await collectDailyGitSaveCandidates({
      repoRoot: localDir,
      dateOrNow: "2026-11-01",
      paperclipSnapshot: snapshot,
    });

    assert.equal(result.classifications.saveCandidates.length, 0);
    const wipExcluded = result.classifications.excluded.find((e) => e.path === "server/src/active-work.ts");
    assert.ok(wipExcluded);
    assert.equal(wipExcluded.reasonCode, "in_progress_or_active_conflict");

    const appExcluded = result.classifications.excluded.find((e) => e.path === "server/src/app.ts");
    assert.ok(appExcluded);
    assert.equal(appExcluded.reasonCode, "contended_core_file_unclear_owner");
  } finally {
    cleanupDirs(localDir, remoteDir);
  }
});

// ---------------------------------------------------------------------------
// 7. 읽기 전용 동작 보장 (Git index / HEAD / objects / working tree 무변조 증명)
// ---------------------------------------------------------------------------

test("7. Read-only guarantee: running collectDailyGitSaveCandidates leaves .git/index, HEAD, objects, and status byte-identical", async () => {
  const { localDir, remoteDir } = initThrowawayRepoWithRemote();
  try {
    writeFileSync(path.join(localDir, "README.md"), "# Changed\n", "utf8");
    writeFileSync(path.join(localDir, "new-untracked.ts"), "export const x = 1;\n", "utf8");

    const indexBefore = readFileSync(path.join(localDir, ".git", "index"));
    const headBefore = git(["rev-parse", "HEAD"], localDir);
    const objectsBefore = git(["count-objects", "-v"], localDir);
    const statusBefore = git(["status", "--porcelain=v1"], localDir);

    await collectDailyGitSaveCandidates({
      repoRoot: localDir,
      dateOrNow: "2026-11-01",
    });

    const indexAfter = readFileSync(path.join(localDir, ".git", "index"));
    const headAfter = git(["rev-parse", "HEAD"], localDir);
    const objectsAfter = git(["count-objects", "-v"], localDir);
    const statusAfter = git(["status", "--porcelain=v1"], localDir);

    assert.ok(indexBefore.equals(indexAfter), ".git/index must be byte-identical after collection");
    assert.equal(headBefore, headAfter, "HEAD must not move");
    assert.equal(objectsBefore, objectsAfter, ".git/objects count must not change");
    assert.equal(statusBefore, statusAfter, "working tree status must not change");
  } finally {
    cleanupDirs(localDir, remoteDir);
  }
});

// ---------------------------------------------------------------------------
// 8. 보고서와 후보 데이터 생성 및 안전한 출력 경로 검증
// ---------------------------------------------------------------------------

test("8. Report & candidate output generation: produces valid Markdown report, prepareRequestCandidate, and blocks writes outside scratch/", async () => {
  const { localDir, remoteDir } = initThrowawayRepoWithRemote();
  try {
    mkdirSync(path.join(localDir, "ui", "src"), { recursive: true });
    writeFileSync(path.join(localDir, "ui", "src", "VerifiedView.tsx"), "export const V = 1;\n", "utf8");

    const snapshot = {
      agents: [{ id: "ag-1", name: "Antigravity" }],
      issues: [
        {
          id: "iss-ok",
          identifier: "NEX-501",
          title: "Verified UI View",
          status: "done",
          assigneeAgentId: "ag-1",
          completedAt: "2026-11-01T16:00:00+09:00",
          verificationStatus: "passed",
          verificationDetail: "Vitest PASS",
          changedFiles: ["ui/src/VerifiedView.tsx"],
        },
      ],
      liveRuns: [],
    };

    const result = await collectDailyGitSaveCandidates({
      repoRoot: localDir,
      dateOrNow: "2026-11-01",
      paperclipSnapshot: snapshot,
    });

    assert.equal(result.gitSaveHandOff.readyForPrepare, true);
    assert.equal(result.gitSaveHandOff.autoGeneratedManifest, null);
    assert.ok(result.gitSaveHandOff.prepareRequestCandidate);
    assert.deepEqual(
      validatePrepareRequest(result.gitSaveHandOff.prepareRequestCandidate, { repoRoot: localDir }),
      [],
    );

    const markdown = renderDailyGitSaveReportMarkdown(result);
    assert.match(markdown, /NEXORA 당일 전체 작업 GitHub 저장 후보 통합 조사 보고서/);
    assert.match(markdown, /ui\/src\/VerifiedView\.tsx/);
    assert.match(markdown, /A\. 저장 후보 \(SAVE_CANDIDATE\) — 1개/);

    // Must refuse to overwrite in-repo source paths outside scratch/
    assert.throws(
      () => validateSafeReportOutputPath(localDir, "ui/src/overwrite.md"),
      /scratch/,
    );
    assert.throws(
      () => validateSafeReportOutputPath(localDir, ".git/evil.json"),
      /\.git/,
    );

    // Writing to scratch/ succeeds cleanly
    const written = writeCollectorOutputs({
      repoRoot: localDir,
      result,
      jsonOutPath: "scratch/test-candidates.json",
      reportOutPath: "scratch/test-report.md",
    });
    assert.ok(written.jsonPath?.endsWith(path.join("scratch", "test-candidates.json")));
    assert.ok(written.reportPath?.endsWith(path.join("scratch", "test-report.md")));
  } finally {
    cleanupDirs(localDir, remoteDir);
  }
});

// ---------------------------------------------------------------------------
// 9. 기존 Git Save Gate 보호 검증
// ---------------------------------------------------------------------------

test("9. Existing Git Save Gate protection: git-save.mjs and git-save-prepare.mjs contracts remain intact and protected files are excluded", async () => {
  assert.equal(ALLOWED_BRANCH, "master");
  assert.deepEqual(ALLOWED_REMOTES, ["origin"]);
  assert.ok(Object.hasOwn(VERIFY_PROFILES, "git-save-self-test"));
  assert.equal(typeof validateManifest, "function");
  assert.equal(typeof validatePrepareRequest, "function");

  const gitSaveSource = readFileSync(GIT_SAVE_SCRIPT_PATH, "utf8");
  const gitSavePrepareSource = readFileSync(GIT_SAVE_PREPARE_PATH, "utf8");
  const collectorSource = readFileSync(COLLECTOR_SCRIPT_PATH, "utf8");

  assert.ok(!gitSaveSource.includes("git-save-collect-daily"), "git-save.mjs must not be modified");
  assert.ok(!gitSavePrepareSource.includes("git-save-collect-daily"), "git-save-prepare.mjs must not be modified");
  assert.ok(!collectorSource.includes("git commit"), "collector must never invoke git commit");
  assert.ok(!collectorSource.includes("git push"), "collector must never invoke git push");

  const parsedArgs = parseCollectorArgs(["--date", "2026-11-01", "--json", "--write-default-output"]);
  assert.equal(parsedArgs.date, "2026-11-01");
  assert.equal(parsedArgs.jsonStdout, true);
  assert.equal(parsedArgs.writeDefaultOutput, true);
});
