import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, issueWorkProducts, issues } from "@paperclipai/db";
import { approvalService } from "./approvals.js";
import { getAgentByIdForDelegation } from "./jarvis-agent-directory.js";
import { computeCompanyActivitySignal, idleMinutesElapsed, SYNC02_IDLE_THRESHOLD_MS } from "./jarvis-idle-activity-detector.js";

const execFileAsync = promisify(execFile);

/**
 * SYNC-02: bridges the already-tested, strictly READ-ONLY
 * `collectDailyGitSaveCandidates` collector (Antigravity's
 * `scripts/operations/git-save-collect-daily.mjs`, unchanged here) to a
 * CEO-visible report. Builds its Paperclip snapshot from `issues`/`agents`
 * directly (not `issueService`, to keep this strictly a read query with no
 * access-control/pagination side effects) and reports the result as a
 * generic board approval — reusing the exact `request_board_approval` type
 * and `approvalService.create` wiring already used by
 * `voice-commands.ts`'s `executePauseCompany`, so Web Push best-effort
 * delivery and the existing Approvals screen work unchanged.
 *
 * Queries `issueWorkProducts` scoped to companyId and groups it by
 * issueId into `workProductsByIssueId`, matching the collector's own
 * existing `analyzePaperclipRecords`/`classifyWorkingTreeEntry` shape
 * exactly (status/reviewState/metadata are the only fields that code
 * reads) -- no new classification rule is introduced here. A completed
 * issue is still never promoted to SAVE_CANDIDATE on its own: the
 * collector's Category A rule additionally requires verificationStatus
 * "passed" (derived from an approved/reviewState==="approved" work
 * product) AND explicit file linkage (from a work product's
 * metadata.resourceRef.path) -- both unchanged, reused as-is.
 */

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface DailySaveSnapshotRow {
  id: string;
  status: string;
  title: string | null;
  identifier: string | null;
  assigneeAgentId: string | null;
  completedAt: Date | null;
  updatedAt: Date;
}

export async function buildPaperclipSnapshotForDailySave(db: Db, companyId: string) {
  const [agentRows, issueRows, workProductRows] = await Promise.all([
    db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.companyId, companyId)),
    db
      .select({
        id: issues.id,
        status: issues.status,
        title: issues.title,
        identifier: issues.identifier,
        assigneeAgentId: issues.assigneeAgentId,
        completedAt: issues.completedAt,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(eq(issues.companyId, companyId)),
    db
      .select({
        issueId: issueWorkProducts.issueId,
        status: issueWorkProducts.status,
        reviewState: issueWorkProducts.reviewState,
        metadata: issueWorkProducts.metadata,
      })
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.companyId, companyId)),
  ]);

  const workProductsByIssueId: Record<string, Array<{ status: string; reviewState: string; metadata: Record<string, unknown> | null }>> = {};
  for (const wp of workProductRows) {
    const list = workProductsByIssueId[wp.issueId] ?? [];
    list.push({ status: wp.status, reviewState: wp.reviewState, metadata: wp.metadata ?? null });
    workProductsByIssueId[wp.issueId] = list;
  }

  return {
    agents: agentRows,
    issues: issueRows.map((row) => ({
      id: row.id,
      identifier: row.identifier ?? row.id,
      title: row.title ?? "(제목 없음)",
      status: row.status,
      assigneeAgentId: row.assigneeAgentId,
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
      updatedAt: row.updatedAt.toISOString(),
      changedFiles: [],
    })),
    liveRuns: [] as unknown[],
    workProductsByIssueId,
  };
}

export interface DailySaveCollectorResult {
  kstWindow: { dateKst: string };
  summaryCounts: Record<string, number>;
  gitSaveHandOff: { readyForPrepare: boolean };
  [key: string]: unknown;
}

export interface RunDailySaveCollectorDeps {
  collectorScriptPath?: string;
  execFileImpl?: typeof execFileAsync;
}

export async function runDailySaveCollector(
  args: { repoRoot: string; paperclipSnapshot: unknown },
  deps: RunDailySaveCollectorDeps = {},
): Promise<{ result: DailySaveCollectorResult; reportMarkdown: string }> {
  const scriptPath =
    deps.collectorScriptPath ??
    path.resolve(args.repoRoot, "scripts/operations/git-save-collect-daily.mjs");
  const run = deps.execFileImpl ?? execFileAsync;
  const workDir = await mkdtemp(path.join(tmpdir(), "sync02-daily-save-"));
  const snapshotPath = path.join(workDir, "snapshot.json");
  const jsonOutPath = path.join(workDir, "candidates.json");
  const reportOutPath = path.join(workDir, "report.md");
  try {
    await writeFile(snapshotPath, JSON.stringify(args.paperclipSnapshot), "utf8");
    await run(
      "node",
      [scriptPath, "--repo-root", args.repoRoot, "--snapshot", snapshotPath, "--json-out", jsonOutPath, "--report-out", reportOutPath],
      { timeout: 30_000 },
    );
    const [resultRaw, reportMarkdown] = await Promise.all([
      readFile(jsonOutPath, "utf8"),
      readFile(reportOutPath, "utf8"),
    ]);
    return { result: JSON.parse(resultRaw), reportMarkdown };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface GenerateDailySaveReportInput {
  db: Db;
  companyId: string;
  jarvisAgentId: string;
  repoRoot: string;
  /**
   * Distinguishes an on-demand "저장하자" report from the unattended 21:00
   * reminder and the Stage A idle-triggered reminder, purely for payload
   * bookkeeping and dedup scoping.
   */
  source: "sync02_on_demand_command" | "sync02_daily_reminder" | "sync02_idle_30min";
  /**
   * Required when source is "sync02_idle_30min": the company-wide last
   * real-progress timestamp (jarvis-idle-activity-detector.ts) that this
   * idle window is anchored to. Used only to scope the idle-specific dedup
   * check below -- never read by the collector itself.
   */
  idleSinceAt?: Date;
  now?: () => Date;
  collectorDeps?: RunDailySaveCollectorDeps;
}

export function computeTodayKstDateString(now: Date): string {
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kst.getUTCDate()).padStart(2, "0");
  return y + "-" + m + "-" + d;
}

async function findExistingDailySaveReminderApproval(db: Db, companyId: string, now: Date): Promise<GenerateDailySaveReportOutput | null> {
  const dateKst = computeTodayKstDateString(now);
  const existing = await db.select().from(approvals).where(and(
    eq(approvals.companyId, companyId),
    inArray(approvals.status, ["pending", "revision_requested"]),
    sql`${approvals.payload} ->> 'source' = 'sync02_daily_reminder'`,
    sql`${approvals.payload} ->> 'dateKst' = ${dateKst}`,
  )).then((rows) => rows[0] ?? null);
  if (!existing) return null;
  const payload = existing.payload as Record<string, unknown>;
  return {
    approvalId: existing.id,
    dateKst,
    reportMarkdown: typeof payload.reportMarkdown === "string" ? payload.reportMarkdown : "",
    result: {
      kstWindow: { dateKst },
      summaryCounts: (payload.summaryCounts as Record<string, number>) ?? {},
      gitSaveHandOff: { readyForPrepare: Boolean(payload.readyForPrepare) },
    },
  };
}

export interface GenerateDailySaveReportOutput {
  approvalId: string | null;
  dateKst: string;
  reportMarkdown: string;
  result: DailySaveCollectorResult;
  /**
   * Populated only for source "sync02_idle_30min" -- distinguishes a fresh
   * report ("created") from a dedup hit on an existing one ("deduplicated")
   * from a tick that found the idle condition no longer held right before
   * inserting ("aborted_activity_resumed"). Absent for the other two
   * sources, whose behavior and return shape are unchanged.
   */
  outcome?: "created" | "deduplicated" | "aborted_activity_resumed";
}

/**
 * SYNC-02 Stage A dedup: scoped to the exact idle-window anchor
 * (`idleSinceAt`, the company-wide last real-progress timestamp from
 * jarvis-idle-activity-detector.ts), matched regardless of the existing
 * approval's status or expiresAt -- at most one report is ever created per
 * (companyId, idleSinceAt), full stop. A new AI employee action moves
 * `idleSinceAt` forward, which opens up a fresh dedup key once another 30
 * minutes of idleness follows that new anchor.
 */
async function findExistingIdleReminderApproval(
  db: Db,
  companyId: string,
  idleSinceAtIso: string,
): Promise<GenerateDailySaveReportOutput | null> {
  const existing = await db.select().from(approvals).where(and(
    eq(approvals.companyId, companyId),
    sql`${approvals.payload} ->> 'source' = 'sync02_idle_30min'`,
    sql`${approvals.payload} ->> 'idleSinceAt' = ${idleSinceAtIso}`,
  )).then((rows) => rows[0] ?? null);
  if (!existing) return null;
  const payload = existing.payload as Record<string, unknown>;
  const dateKst = typeof payload.dateKst === "string" ? payload.dateKst : "";
  return {
    approvalId: existing.id,
    dateKst,
    reportMarkdown: typeof payload.reportMarkdown === "string" ? payload.reportMarkdown : "",
    result: {
      kstWindow: { dateKst },
      summaryCounts: (payload.summaryCounts as Record<string, number>) ?? {},
      gitSaveHandOff: { readyForPrepare: Boolean(payload.readyForPrepare) },
    },
  };
}

/**
 * Collects today's (KST) Git-save candidates and records a generic board
 * approval carrying the full report. Never executes `git add`/`commit`/
 * `push`/any Git Save Gate step itself -- the collector it calls is
 * read-only by construction, and an approval record here is purely a CEO-
 * visible report + review request, never an authorization to mutate Git.
 */
export async function generateDailyGitSaveReportAndApproval(
  input: GenerateDailySaveReportInput,
): Promise<GenerateDailySaveReportOutput> {
  const { db, companyId, jarvisAgentId, repoRoot, source } = input;
  const now = input.now ?? (() => new Date());

  // SYNC-02 security fix: reuse the exact same identity-boundary check
  // submitToJarvis already performs (jarvis-delegation-orchestrator.ts) --
  // agent must exist and belong to the requested company -- before doing
  // anything else. Throws (never creates an approval) on failure, exactly
  // like a collector failure below.
  const jarvisAgent = await getAgentByIdForDelegation(db, jarvisAgentId);
  if (!jarvisAgent) {
    throw new Error(`SYNC-02: no agent found with id ${jarvisAgentId}`);
  }
  if (jarvisAgent.companyId !== companyId) {
    throw new Error(
      `SYNC-02: agent ${jarvisAgentId} belongs to company ${jarvisAgent.companyId}, not the requested company ${companyId}`,
    );
  }

  if (source === "sync02_daily_reminder") {
    const existingDedup = await findExistingDailySaveReminderApproval(db, companyId, now());
    if (existingDedup) return existingDedup;
  }

  if (source === "sync02_idle_30min") {
    if (!input.idleSinceAt) {
      throw new Error("SYNC-02: idleSinceAt is required when source is sync02_idle_30min");
    }
    const idleSinceAt = input.idleSinceAt;
    const idleSinceAtIso = idleSinceAt.toISOString();
    // This advisory lock exists ONLY to prevent two server instances from
    // both inserting a report for the exact same (companyId, idleSinceAt)
    // window -- it is NOT, and cannot be, synchronized with an AI employee's
    // work actually starting (heartbeat.ts's wakeup dispatch never acquires
    // this key). The real-world gap between "a new run/wakeup decision is
    // made" and "its row is committed and visible to computeCompanyActivitySignal"
    // is a structural safety limit of this Stage A design: it is narrowed by
    // the recent-created-row buffer in jarvis-idle-activity-detector.ts and
    // by re-reading activity right before the insert below, but it is never
    // fully eliminated without modifying heartbeat.ts, which is out of scope
    // here. The only reason this gap is acceptable is that this function
    // never executes git add/commit/push itself -- the worst outcome is a
    // slightly stale CEO-visible report, never an unsafe save.
    const lockKey = `sync02-idle-reminder:${companyId}:${idleSinceAtIso}`;

    // Cheap optimization only (not the authoritative check): avoids running
    // the collector when another tick/instance has already reported for
    // this exact idle window.
    const earlyDedup = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      return findExistingIdleReminderApproval(tx as unknown as Db, companyId, idleSinceAtIso);
    });
    if (earlyDedup) return { ...earlyDedup, outcome: "deduplicated" as const };

    const idlePaperclipSnapshot = await buildPaperclipSnapshotForDailySave(db, companyId);
    const idleCollected = await runDailySaveCollector(
      { repoRoot, paperclipSnapshot: idlePaperclipSnapshot },
      input.collectorDeps,
    );

    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

      // Authoritative re-check #1: has another instance already reported
      // for this exact idle window while we were building the snapshot /
      // running the collector?
      const lateDedup = await findExistingIdleReminderApproval(tx as unknown as Db, companyId, idleSinceAtIso);
      if (lateDedup) return { ...lateDedup, outcome: "deduplicated" as const };

      // Authoritative re-check #2: re-read company-wide activity right
      // before inserting, and explicitly re-verify the 30-minute threshold
      // against a fresh `now()` reading -- not just that idleSinceAt is
      // unchanged. Abort without creating an approval if anything is now
      // running/queued/just-created, if a newer lastUsefulActionAt has
      // appeared, or if the elapsed time no longer meets the threshold.
      const freshNow = now();
      const freshSignal = await computeCompanyActivitySignal(tx as unknown as Db, companyId, freshNow);
      const sameAnchor =
        freshSignal.state === "idle_since" && freshSignal.idleSinceAt.getTime() === idleSinceAt.getTime();
      const stillBeyondThreshold =
        sameAnchor &&
        freshSignal.state === "idle_since" &&
        idleMinutesElapsed(freshSignal.idleSinceAt, freshNow) >= SYNC02_IDLE_THRESHOLD_MS / 60_000;
      if (!stillBeyondThreshold) {
        return {
          approvalId: null,
          dateKst: idleCollected.result.kstWindow.dateKst,
          reportMarkdown: "",
          result: {
            kstWindow: idleCollected.result.kstWindow,
            summaryCounts: {},
            gitSaveHandOff: { readyForPrepare: false },
          },
          outcome: "aborted_activity_resumed" as const,
        };
      }

      const created = await approvalService(tx as unknown as Db).create(companyId, {
        type: "request_board_approval",
        requestedByAgentId: jarvisAgentId,
        requestedByUserId: null,
        status: "pending",
        payload: {
          title: `SYNC-02 무작업 30분 감지 GitHub 저장 후보 보고 (${idleCollected.result.kstWindow.dateKst})`,
          summary:
            "AI 직원 전원이 30분간 실제 작업을 진행하지 않아 생성된 읽기 전용 조사 결과입니다. 이 승인은 Git 변경을 실행하지 않으며, 실제 저장은 기존 Git Save Gate에서 CEO가 SAVE를 입력한 경우에만 실행됩니다.",
          recommendedAction:
            idleCollected.result.summaryCounts.saveCandidateCount > 0
              ? "저장 후보 목록을 검토한 뒤, 승인 시 Git Save Gate manifest 준비를 진행하세요."
              : "지금은 자동 승격된 저장 후보가 없습니다. 검토가 필요한 항목만 확인해 주세요.",
          nextActionOnApproval:
            "이 승인은 보고 확인용입니다. 실제 커밋/푸시는 별도로 Git Save Gate(git-save.mjs)에서 CEO가 직접 SAVE를 입력해야 실행됩니다.",
          risks: ["이 보고는 Paperclip 이슈 검증 상태(work product)를 아직 연동하지 않아, 완료 이슈만으로는 저장 후보로 자동 승격되지 않습니다."],
          source,
          idleSinceAt: idleSinceAtIso,
          dateKst: idleCollected.result.kstWindow.dateKst,
          summaryCounts: idleCollected.result.summaryCounts,
          readyForPrepare: idleCollected.result.gitSaveHandOff.readyForPrepare,
          reportMarkdown: idleCollected.reportMarkdown,
        },
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        expiresAt: new Date(freshNow.getTime() + ONE_DAY_MS),
      });

      return {
        approvalId: created?.id ?? null,
        dateKst: idleCollected.result.kstWindow.dateKst,
        reportMarkdown: idleCollected.reportMarkdown,
        result: idleCollected.result,
        outcome: "created" as const,
      };
    });
  }

  const paperclipSnapshot = await buildPaperclipSnapshotForDailySave(db, companyId);
  const { result, reportMarkdown } = await runDailySaveCollector(
    { repoRoot, paperclipSnapshot },
    input.collectorDeps,
  );

  const approvals = approvalService(db);
  const created = await approvals.create(companyId, {
    type: "request_board_approval",
    requestedByAgentId: jarvisAgentId,
    requestedByUserId: null,
    status: "pending",
    payload: {
      title: `SYNC-02 일일 GitHub 저장 후보 보고 (${result.kstWindow.dateKst})`,
      summary:
        "읽기 전용 조사 결과입니다. 이 승인은 Git 변경을 실행하지 않으며, 실제 저장은 기존 Git Save Gate에서 CEO가 SAVE를 입력한 경우에만 실행됩니다.",
      recommendedAction:
        result.summaryCounts.saveCandidateCount > 0
          ? "저장 후보 목록을 검토한 뒤, 승인 시 Git Save Gate manifest 준비를 진행하세요."
          : "오늘은 자동 승격된 저장 후보가 없습니다. 검토가 필요한 항목만 확인해 주세요.",
      nextActionOnApproval:
        "이 승인은 보고 확인용입니다. 실제 커밋/푸시는 별도로 Git Save Gate(git-save.mjs)에서 CEO가 직접 SAVE를 입력해야 실행됩니다.",
      risks: ["이 보고는 Paperclip 이슈 검증 상태(work product)를 아직 연동하지 않아, 완료 이슈만으로는 저장 후보로 자동 승격되지 않습니다."],
      source,
      dateKst: result.kstWindow.dateKst,
      summaryCounts: result.summaryCounts,
      readyForPrepare: result.gitSaveHandOff.readyForPrepare,
      reportMarkdown,
    },
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    expiresAt: new Date(now().getTime() + ONE_DAY_MS),
  });

  return {
    approvalId: created?.id ?? null,
    dateKst: result.kstWindow.dateKst,
    reportMarkdown,
    result,
  };
}
