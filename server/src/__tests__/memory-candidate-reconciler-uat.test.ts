import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  companies,
  companyMemberships,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueDocuments,
  issues,
  memoryOperations,
  principalPermissionGrants,
  agents,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import { createFailureCooldownTracker } from "../services/memory-candidate-failure-cooldown.js";
import {
  extractMemoryOperationCandidateFromCompletedIssue,
  findCompletedIssuesEligibleForAutomaticExtraction,
  reconcileAutomaticMemoryOperationCandidates,
  MEMORY_CANDIDATE_RECONCILER_SYSTEM_ACTOR_ID,
} from "../services/memory-candidate-extraction.js";
import { resolveMemoryCandidateReconcilerConfig } from "../services/memory-candidate-reconciler-config.js";
import { createMemoryCandidateReconcilerScheduler } from "../services/memory-candidate-reconciler-scheduler.js";
import {
  describeEmbeddedPostgres,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

const SYSTEM_ACTOR = {
  actorType: "system" as const,
  actorId: MEMORY_CANDIDATE_RECONCILER_SYSTEM_ACTOR_ID,
  agentId: null,
  runId: null,
};

async function resetFixtures(db: Db) {
  await db.delete(activityLog);
  await db.delete(memoryOperations);
  await db.delete(issueDocuments);
  await db.delete(documentRevisions);
  await db.delete(documents);
  await db.delete(heartbeatRuns);
  await db.delete(issues);
  await db.delete(agents);
  await db.delete(principalPermissionGrants);
  await db.delete(companyMemberships);
  await db.delete(companies);
}

describeEmbeddedPostgres("NEXORA Knowledge Layer v0.1 — Phase 3.0B Non-production volume UAT", () => {
  const ctx = useEmbeddedPostgres("paperclip-reconciler-uat-", { resetEach: resetFixtures });

  // Bulk seeding helper for high volume UAT
  async function seedIssuesBulk(
    companyId: string,
    count: number,
    opts: {
      status?: string;
      body?: string;
      completedAt?: Date | null;
      hasSummary?: boolean;
    } = {},
  ) {
    const status = opts.status ?? "done";
    const body = opts.body ?? "# Continuation Summary\n\n- Status: done\n- Next Action: none";
    const hasSummary = opts.hasSummary ?? true;

    const issueValues = [];
    const docValues = [];
    const revValues = [];
    const issueDocValues = [];

    for (let i = 0; i < count; i++) {
      const issueId = randomUUID();
      const documentId = randomUUID();
      const revisionId = randomUUID();

      // Stable sorting helper: completedAt = opts.completedAt, if null, fallback to COALESCE
      const now = new Date();
      now.setMilliseconds(now.getMilliseconds() + i); // ensure unique timestamp order

      issueValues.push({
        id: issueId,
        companyId,
        title: `UAT Issue ${i}`,
        identifier: `UAT-${issueId.slice(0, 8)}`,
        status,
        completedAt: opts.completedAt !== undefined ? opts.completedAt : now,
        updatedAt: now,
        createdAt: now,
      });

      if (hasSummary) {
        docValues.push({
          id: documentId,
          companyId,
          title: "Continuation Summary",
          format: "markdown",
          latestBody: body,
          latestRevisionId: revisionId,
          latestRevisionNumber: 1,
        });

        revValues.push({
          id: revisionId,
          companyId,
          documentId,
          revisionNumber: 1,
          title: "Continuation Summary",
          format: "markdown",
          body,
          createdByAgentId: null,
          createdByRunId: null,
        });

        issueDocValues.push({
          companyId,
          issueId,
          documentId,
          key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
        });
      }
    }

    if (issueValues.length > 0) await ctx.db.insert(issues).values(issueValues);
    if (docValues.length > 0) await ctx.db.insert(documents).values(docValues);
    if (revValues.length > 0) await ctx.db.insert(documentRevisions).values(revValues);
    if (issueDocValues.length > 0) await ctx.db.insert(issueDocuments).values(issueDocValues);
  }

  // --- UAT Scenario 1: 정상 볼륨 처리 ---
  it("Scenario 1: 정상 볼륨 UAT (1,000개 Issue 및 후보 1:1 검증)", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "UAT Scenario 1 Co");
    const count = 1000;

    // 1. 최소 1,000개의 완료 Issue 벌크 생성
    const startTime = Date.now();
    await seedIssuesBulk(company.companyId, count, { status: "done" });
    const seedTime = Date.now() - startTime;

    const cooldownTracker = createFailureCooldownTracker();
    const config = { batchSize: 20, scanLimit: 100 };

    let totalTicks = 0;
    let totalScanned = 0;
    let totalAttempted = 0;
    let totalCreated = 0;
    let totalDeduplicated = 0;
    let totalFailed = 0;
    let totalSkippedCooldown = 0;

    // 2. batchSize 20, scanLimit 100 조건으로 모든 이슈가 처리될 때까지 반복
    //
    // Self-imposed wall-clock bound: extraction is fully sequential (one
    // Issue at a time, several DB round trips each — see
    // docs/investigations/... root-cause analysis, 2026-09-09), so 1,000
    // Issues genuinely takes on the order of minutes against embedded
    // Postgres. Vitest's own per-test timeout does NOT cancel an
    // already-in-flight test body when it fires — it only stops waiting and
    // reports failure, while this loop would keep running in the
    // background and race the next test's `afterEach` resetFixtures
    // cleanup (observed as a spurious `activity_log` FK violation on
    // `companies` deletion). Throwing here, well before the `it(...)`
    // timeout below, guarantees this loop always settles (reject) on its
    // own and never survives past this test into a cleanup hook.
    const SELF_IMPOSED_WALL_CLOCK_LIMIT_MS = 400_000;
    const runStartTime = Date.now();
    while (true) {
      if (Date.now() - runStartTime > SELF_IMPOSED_WALL_CLOCK_LIMIT_MS) {
        throw new Error(
          `Scenario 1 self-imposed wall-clock limit (${SELF_IMPOSED_WALL_CLOCK_LIMIT_MS}ms) exceeded ` +
          `after ${totalTicks} ticks (scanned=${totalScanned}, attempted=${totalAttempted}, created=${totalCreated}/${count}) — ` +
          `aborting the loop itself so no reconcile work is left running past this test's own promise settling.`,
        );
      }

      const res = await reconcileAutomaticMemoryOperationCandidates(ctx.db, {
        batchSize: config.batchSize,
        scanLimit: config.scanLimit,
        cooldown: cooldownTracker,
      });

      totalTicks += 1;
      totalScanned += res.scanned;
      totalAttempted += res.attempted;
      totalCreated += res.created;
      totalDeduplicated += res.deduplicated;
      totalFailed += res.failed;
      totalSkippedCooldown += res.skippedCooldown;

      if (res.created === 0 && res.attempted === 0) {
        break;
      }
    }
    const runTime = Date.now() - runStartTime;

    // 3. UAT 검증 단언식
    expect(totalCreated).toBe(count);
    expect(totalFailed).toBe(0);
    expect(totalDeduplicated).toBe(0);
    expect(totalSkippedCooldown).toBe(0);

    // 각 이슈당 정확히 1개의 candidate와 1개의 activity_log가 생성되었는지 확인
    const ops = await ctx.db.select().from(memoryOperations);
    expect(ops.length).toBe(count);
    for (const op of ops) {
      expect(op.status).toBe("candidate");
      expect(op.reviewState).toBe("pending");
    }

    const activities = await ctx.db.select().from(activityLog).where(eq(activityLog.action, "memory_operation.auto_created"));
    expect(activities.length).toBe(count);

    console.log(`[UAT Scenario 1] Seed Time: ${seedTime}ms | Execution Time: ${runTime}ms | Ticks: ${totalTicks} | Throughput: ${(count / (runTime / 1000)).toFixed(2)} candidates/sec`);
  }, 450000); // 450s test timeout — kept comfortably above the 400s self-imposed loop bound above, so the loop's own throw fires first in the slow-regression case and this outer value is only a final backstop.

  // --- UAT Scenario 2: 혼합 eligibility 및 revision 변경 검증 ---
  it("Scenario 2: 혼합 eligibility 기대값 정밀 검증", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "UAT Scenario 2 Co");

    // 사전 설계된 개수 분석:
    // 1. done + 정상 summary -> 1개 생성 (대상)
    await seedIssuesBulk(company.companyId, 1, { status: "done", body: "# Normal summary" });
    // 2. done + summary 없음 -> 0개 생성 (제외)
    await seedIssuesBulk(company.companyId, 1, { status: "done", hasSummary: false });
    // 3. done + 빈 문자열 summary -> 0개 생성 (제외)
    await seedIssuesBulk(company.companyId, 1, { status: "done", body: "" });
    // 4. done + 공백/탭/개행만 존재 summary -> 0개 생성 (제외)
    await seedIssuesBulk(company.companyId, 1, { status: "done", body: "   \n\t   " });
    // 5. done + manual Phase 3.0A 후보 존재 -> 0개 생성 (제외)
    const issueManualId = randomUUID();
    await ctx.db.insert(issues).values({ id: issueManualId, companyId: company.companyId, title: "Manual Issue", identifier: "UAT-MANUAL", status: "done" });
    await ctx.db.insert(memoryOperations).values({
      id: randomUUID(),
      companyId: company.companyId,
      sourceType: "document",
      sourceId: randomUUID(),
      sourceIssueId: issueManualId,
      content: "# Continuation Summary\n\n- Status: done",
      status: "candidate",
      reviewState: "pending",
      extractionKey: `doc-manual-${issueManualId}`,
      metadata: { extractionReason: "issue_completed_continuation_summary" },
      createdByActorType: "user",
      createdByActorId: company.userId,
    });
    // 6. done + 이전 자동 후보 존재 -> 0개 생성 (제외)
    const issueAutoId = randomUUID();
    await ctx.db.insert(issues).values({ id: issueAutoId, companyId: company.companyId, title: "Auto Issue", identifier: "UAT-AUTO", status: "done" });
    await ctx.db.insert(memoryOperations).values({
      id: randomUUID(),
      companyId: company.companyId,
      sourceType: "document",
      sourceId: randomUUID(),
      sourceIssueId: issueAutoId,
      content: "# Continuation Summary\n\n- Status: done",
      status: "candidate",
      reviewState: "pending",
      extractionKey: `doc-auto-${issueAutoId}`,
      metadata: { extractionReason: "issue_completed_continuation_summary" },
      createdByActorType: "system",
      createdByActorId: "memory-candidate-reconciler",
    });
    // 7. done + 이후 summary revision 변경 -> UAT Scenario 2 기생성 상태이므로 0개 (제외)
    // 8. in_progress 또는 기타 비완료 상태 -> 0개 생성 (제외)
    await seedIssuesBulk(company.companyId, 1, { status: "in_progress" });
    // 9. completedAt = null인 import Issue (정상 summary 보유) -> 1개 생성 (대상)
    await seedIssuesBulk(company.companyId, 1, { status: "done", completedAt: null });

    // 사전 계산: 정상적으로 자동 추출 대상이어야 하는 건수는 1번(정상 summary)과 9번(completedAt = null인 정상 summary) 총 2건입니다.
    const cooldownTracker = createFailureCooldownTracker();
    const res = await reconcileAutomaticMemoryOperationCandidates(ctx.db, {
      batchSize: 10,
      cooldown: cooldownTracker,
    });

    expect(res.created).toBe(2);
    expect(res.attempted).toBe(2);

    const ops = await ctx.db.select().from(memoryOperations);
    // 원래 5, 6번으로 2개 수동 삽입되어 있었으므로 총 4개여야 함
    expect(ops.length).toBe(4);

    // --- 이후 revision 변경 및 E2E 중복/수동 추출 검증 ---
    // 1. 기존 자동 추출이 성공했던 정상 이슈의 문서 조회
    const normalIssues = await ctx.db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, company.companyId), eq(issues.status, "done")));
    const targetIssue = normalIssues.find(i => i.identifier !== "UAT-MANUAL" && i.identifier !== "UAT-AUTO")!;
    const targetIssueId = targetIssue.id;

    const existingDoc = (
      await ctx.db
        .select()
        .from(issueDocuments)
        .where(eq(issueDocuments.issueId, targetIssueId))
    )[0]!;

    const newRevisionId = randomUUID();
    await ctx.db.insert(documentRevisions).values({
      id: newRevisionId,
      companyId: company.companyId,
      documentId: existingDoc.documentId,
      revisionNumber: 2,
      title: "Continuation Summary",
      format: "markdown",
      body: "# Updated Continuation Summary\n\n- Status: done\n- Action: updated",
      createdByAgentId: null,
      createdByRunId: null,
    });

    await ctx.db
      .update(documents)
      .set({
        latestRevisionId: newRevisionId,
        latestRevisionNumber: 2,
        latestBody: "# Updated Continuation Summary\n\n- Status: done\n- Action: updated",
      })
      .where(eq(documents.id, existingDoc.documentId));

    // 변경 전 상태 캡처
    const opsBefore = await ctx.db.select().from(memoryOperations);
    const activitiesBefore = await ctx.db.select().from(activityLog).where(eq(activityLog.action, "memory_operation.auto_created"));

    // 2. 다시 reconciliation 실행 (자동 주기 실행 모사)
    const resAfterUpdate = await reconcileAutomaticMemoryOperationCandidates(ctx.db, {
      batchSize: 10,
      cooldown: cooldownTracker,
    });
    // 추가 자동 후보가 생성되지 않아야 함 (이미 해당 issue 에 대한 continuation-summary 후보가 존재하므로)
    expect(resAfterUpdate.created).toBe(0);

    // 수치적으로 자동 후보와 자동 activity가 증가하지 않았는지 모두 단언
    const opsAfter = await ctx.db.select().from(memoryOperations);
    const activitiesAfter = await ctx.db.select().from(activityLog).where(eq(activityLog.action, "memory_operation.auto_created"));
    expect(opsAfter.length).toBe(opsBefore.length);
    expect(activitiesAfter.length).toBe(activitiesBefore.length);

    // 3. manual Phase 3.0A API가 새 revision을 명시적으로 추출할 수 있는 기존 계약 검증
    const manualActor = {
      actorType: "user" as const,
      actorId: company.userId,
      agentId: null,
      runId: null,
    };
    const manualRes = await extractMemoryOperationCandidateFromCompletedIssue(
      ctx.db,
      company.companyId,
      targetIssueId,
      manualActor,
    );
    expect(manualRes.outcome).toBe("created");
    expect(manualRes.operation.content).toBe("# Updated Continuation Summary\n\n- Status: done\n- Action: updated");
  });

  // --- UAT Scenario 3: 실패·cooldown·starvation 및 실패 후 실제 복구 E2E ---
  it("Scenario 3: 실패, 쿨다운 만료 후 재시도 및 스타베이션 방지 UAT", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "UAT Scenario 3 Co");

    // 타 회사(Company B)에 속한 Agent 생성하여 회사 경계 위반 에러 유도
    const otherCompany = await seedCompanyWithBoardAccess(ctx.db, "Other Co");
    const otherAgentId = randomUUID();
    await ctx.db.insert(agents).values({
      id: otherAgentId,
      companyId: otherCompany.companyId,
      name: "Other Agent",
    });

    // 1. 선두에 실패할 이슈 배치:
    const issueFailId = randomUUID();
    const docFailId = randomUUID();
    const revFailId = randomUUID();
    await ctx.db.insert(issues).values({
      id: issueFailId,
      companyId: company.companyId,
      title: "Fail Issue",
      identifier: "UAT-FAIL",
      status: "done",
      completedAt: new Date(2026, 1, 1), // 가장 먼저 정렬되도록 완료 일자를 과거로 설정
    });
    await ctx.db.insert(documents).values({
      id: docFailId,
      companyId: company.companyId,
      title: "Continuation Summary",
      format: "markdown",
      latestBody: "summary",
      latestRevisionId: revFailId,
      latestRevisionNumber: 1,
    });
    // revision에 타 회사 소속 Agent의 ID를 부여하여 회사 교차 검증 FK 에러를 시뮬레이션
    await ctx.db.insert(documentRevisions).values({
      id: revFailId,
      companyId: company.companyId,
      documentId: docFailId,
      revisionNumber: 1,
      title: "Continuation Summary",
      format: "markdown",
      body: "# Summary",
      createdByAgentId: otherAgentId, // seeding succeeds, but extraction throws company mismatch!
    });
    await ctx.db.insert(issueDocuments).values({
      companyId: company.companyId,
      issueId: issueFailId,
      documentId: docFailId,
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    });

    // 2. 그 뒤에 정상 이슈 배치
    const issueSuccessId = randomUUID();
    await ctx.db.insert(issues).values({
      id: issueSuccessId,
      companyId: company.companyId,
      title: "Success Issue",
      identifier: "UAT-SUCCESS",
      status: "done",
      completedAt: new Date(2026, 1, 2),
    });
    // 정상 summary 연계
    const docSuccessId = randomUUID();
    const revSuccessId = randomUUID();
    await ctx.db.insert(documents).values({ id: docSuccessId, companyId: company.companyId, title: "Continuation Summary", format: "markdown", latestBody: "success summary", latestRevisionId: revSuccessId, latestRevisionNumber: 1 });
    await ctx.db.insert(documentRevisions).values({ id: revSuccessId, companyId: company.companyId, documentId: docSuccessId, revisionNumber: 1, title: "Continuation Summary", format: "markdown", body: "# Success summary" });
    await ctx.db.insert(issueDocuments).values({ companyId: company.companyId, issueId: issueSuccessId, documentId: docSuccessId, key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY });

    // 3. 쿨다운 트래커 초기 설정 (가짜 시계 주입형)
    let mockTime = Date.now();
    const cooldownTracker = createFailureCooldownTracker({
      cooldownMs: 50,
      maxEntries: 10,
      now: () => mockTime,
    });

    // 첫 번째 tick 실행: 선두의 실패 이슈로 인해 실패 발생, 뒤의 정상 이슈는 starvation 없이 성공해야 함
    const res1 = await reconcileAutomaticMemoryOperationCandidates(ctx.db, {
      batchSize: 2,
      scanLimit: 5,
      cooldown: cooldownTracker,
    });

    expect(res1.attempted).toBe(2);
    expect(res1.created).toBe(1); // 정상 1개 성공
    expect(res1.failed).toBe(1);  // 비정상 1개 실패

    // 실패한 이슈는 쿨다운 중이어야 함
    expect(cooldownTracker.isInCooldown(issueFailId)).toBe(true);

    // 두 번째 tick 실행: 실패 이슈가 쿨다운 중이므로 attempt 수를소비하지 않고 스킵되어야 함
    const res2 = await reconcileAutomaticMemoryOperationCandidates(ctx.db, {
      batchSize: 2,
      scanLimit: 5,
      cooldown: cooldownTracker,
    });

    expect(res2.skippedCooldown).toBe(1);
    expect(res2.attempted).toBe(0); // 더 이상 대기중인 정상 이슈가 없으므로 attempt 0

    // --- 실패 후 실제 복구 E2E 검증 ---
    // 1. 가짜 시계를 60ms 전진시켜 쿨다운 만료 처리 (실제 sleep 없음)
    mockTime += 60;
    expect(cooldownTracker.isInCooldown(issueFailId)).toBe(false);

    // 2. 실패를 유도했던 타 회사 Agent 할당 조건을 제거 (null로 업데이트)
    await ctx.db
      .update(documentRevisions)
      .set({ createdByAgentId: null })
      .where(eq(documentRevisions.id, revFailId));

    // 3. 세 번째 tick 실행 (실제 reconcile 경로를 통해 성공 확인)
    const res3 = await reconcileAutomaticMemoryOperationCandidates(ctx.db, {
      batchSize: 2,
      scanLimit: 5,
      cooldown: cooldownTracker,
    });

    expect(res3.created).toBe(1); // 정상적으로 추출 성공
    expect(res3.failed).toBe(0);

    // 4. 성공 후 cooldown tracker entry가 실제 reconcile 내부의 recordSuccess()를 통해 쿨다운 목록에서 제거되었는지 확인
    expect(cooldownTracker.isInCooldown(issueFailId)).toBe(false);

    // 5. 최종 후보와 activity가 각각 정확히 1개 생성되었는지 검증 (activityLog.issueId 대신 entityType, entityId 기준 단언)
    const opsForFailIssue = await ctx.db
      .select()
      .from(memoryOperations)
      .where(eq(memoryOperations.sourceIssueId, issueFailId));
    expect(opsForFailIssue.length).toBe(1);

    const activitiesForFailIssue = await ctx.db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityType, "memory_operation"),
          eq(activityLog.entityId, opsForFailIssue[0]!.id),
          eq(activityLog.action, "memory_operation.auto_created"),
        ),
      );
    expect(activitiesForFailIssue.length).toBe(1);

    // 쿨다운 맵 최대 크기 한계 단언
    const smallCooldown = createFailureCooldownTracker({ maxEntries: 2 });
    smallCooldown.recordFailure("fail-1");
    smallCooldown.recordFailure("fail-2");
    smallCooldown.recordFailure("fail-3"); // fail-1 방출 유도

    // fail-1은 쿨다운 맵에서 밀려나 쿨다운 상태가 아니어야 함
    expect(smallCooldown.isInCooldown("fail-1")).toBe(false);
    expect(smallCooldown.isInCooldown("fail-2")).toBe(true);
    expect(smallCooldown.isInCooldown("fail-3")).toBe(true);
  });

  // --- UAT Scenario 4: 동시·다중 인스턴스 모사 및 원자성 검증 ---
  it("Scenario 4: 동시 구동 및 트랜잭션 롤백 안정성 UAT", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "UAT Scenario 4 Co");

    // 1. Issue 1 명시적 시딩 (동시성 멱등성 검증용)
    const issueId1 = randomUUID();
    const docId1 = randomUUID();
    const revId1 = randomUUID();
    await ctx.db.insert(issues).values({
      id: issueId1,
      companyId: company.companyId,
      title: "UAT Issue 1",
      identifier: "UAT-1",
      status: "done",
      completedAt: new Date(),
    });
    await ctx.db.insert(documents).values({
      id: docId1,
      companyId: company.companyId,
      title: "Continuation Summary",
      format: "markdown",
      latestBody: "# Summary 1",
      latestRevisionId: revId1,
      latestRevisionNumber: 1,
    });
    await ctx.db.insert(documentRevisions).values({
      id: revId1,
      companyId: company.companyId,
      documentId: docId1,
      revisionNumber: 1,
      title: "Continuation Summary",
      format: "markdown",
      body: "# Summary 1",
      createdByAgentId: null,
      createdByRunId: null,
    });
    await ctx.db.insert(issueDocuments).values({
      companyId: company.companyId,
      issueId: issueId1,
      documentId: docId1,
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    });

    // 2. Issue 2 명시적 시딩 (트랜잭션 롤백 및 사후 복구 검증용)
    const issueId2 = randomUUID();
    const docId2 = randomUUID();
    const revId2 = randomUUID();
    await ctx.db.insert(issues).values({
      id: issueId2,
      companyId: company.companyId,
      title: "UAT Issue 2",
      identifier: "UAT-2",
      status: "done",
      completedAt: new Date(),
    });
    await ctx.db.insert(documents).values({
      id: docId2,
      companyId: company.companyId,
      title: "Continuation Summary",
      format: "markdown",
      latestBody: "# Summary 2",
      latestRevisionId: revId2,
      latestRevisionNumber: 1,
    });
    await ctx.db.insert(documentRevisions).values({
      id: revId2,
      companyId: company.companyId,
      documentId: docId2,
      revisionNumber: 1,
      title: "Continuation Summary",
      format: "markdown",
      body: "# Summary 2",
      createdByAgentId: null,
      createdByRunId: null,
    });
    await ctx.db.insert(issueDocuments).values({
      companyId: company.companyId,
      issueId: issueId2,
      documentId: docId2,
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    });

    // --- 동시성 멱등성 검증 (Issue 1 대상) ---
    const [res1, res2] = await Promise.all([
      extractMemoryOperationCandidateFromCompletedIssue(ctx.db, company.companyId, issueId1, SYSTEM_ACTOR),
      extractMemoryOperationCandidateFromCompletedIssue(ctx.db, company.companyId, issueId1, SYSTEM_ACTOR),
    ]);

    const outcomes = [res1.outcome, res2.outcome];
    expect(outcomes).toContain("created");
    expect(outcomes).toContain("deduplicated");

    // 단언 5: issueId1의 최종 후보 1건 및 activity 1건 생성 확인
    const ops1 = await ctx.db
      .select()
      .from(memoryOperations)
      .where(eq(memoryOperations.sourceIssueId, issueId1));
    expect(ops1.length).toBe(1);

    const activities1 = await ctx.db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityType, "memory_operation"),
          eq(activityLog.entityId, ops1[0]!.id),
          eq(activityLog.action, "memory_operation.auto_created"),
        ),
      );
    expect(activities1.length).toBe(1);

    // --- 트랜잭션 롤백 및 사후 복구 검증 (Issue 2 대상) ---
    // 단언 1: 롤백 시도 전 issueId2 후보가 0건인지 확인
    const ops2Before = await ctx.db
      .select()
      .from(memoryOperations)
      .where(eq(memoryOperations.sourceIssueId, issueId2));
    expect(ops2Before.length).toBe(0);

    // 롤백 시도 전 자동 activity 개수 캡처
    const activities2BeforeRollback = await ctx.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "memory_operation.auto_created"));

    // 단언 2: 잘못된 actor/run 참조로 호출한 Promise가 실제 reject되는지 확인
    const invalidActor = {
      actorType: "user" as const,
      actorId: company.userId,
      agentId: null,
      runId: randomUUID(), // 존재하지 않는 runId
    };

    await expect(
      extractMemoryOperationCandidateFromCompletedIssue(ctx.db, company.companyId, issueId2, invalidActor)
    ).rejects.toThrow();

    // 단언 3: reject 후 issueId2 후보가 0건이고, 관련 자동 activity 총개수가 증가하지 않았음을 단언
    const ops2AfterFail = await ctx.db
      .select()
      .from(memoryOperations)
      .where(eq(memoryOperations.sourceIssueId, issueId2));
    expect(ops2AfterFail.length).toBe(0);

    const activities2AfterFail = await ctx.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "memory_operation.auto_created"));
    expect(activities2AfterFail.length).toBe(activities2BeforeRollback.length);

    // 단언 4: 이후 유효한 system actor로 같은 issueId2를 다시 처리하여 후보와 자동 activity가 각각 정확히 1건 생성되는지 확인
    const resRecovery = await extractMemoryOperationCandidateFromCompletedIssue(
      ctx.db,
      company.companyId,
      issueId2,
      SYSTEM_ACTOR,
    );
    expect(resRecovery.outcome).toBe("created");

    const ops2Recovery = await ctx.db
      .select()
      .from(memoryOperations)
      .where(eq(memoryOperations.sourceIssueId, issueId2));
    expect(ops2Recovery.length).toBe(1);

    const activities2Recovery = await ctx.db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityType, "memory_operation"),
          eq(activityLog.entityId, ops2Recovery[0]!.id),
          eq(activityLog.action, "memory_operation.auto_created"),
        ),
      );
    expect(activities2Recovery.length).toBe(1);
  });

  // --- UAT Scenario 5: scheduler 부하와 생명주기 ---
  it("Scenario 5: single-flight 락 스위칭 및 graceful shutdown UAT", async () => {
    let tickCount = 0;
    let activeTicks = 0;
    let maxConcurrentTicks = 0;

    // 비동기 tick 지연 모사를 위해 Deferred Promise 기법 사용
    let resolveTick: () => void = () => {};
    const tickPromise = new Promise<void>((resolve) => {
      resolveTick = resolve;
    });

    const mockReconcile = async () => {
      activeTicks += 1;
      maxConcurrentTicks = Math.max(maxConcurrentTicks, activeTicks);
      tickCount += 1;
      await tickPromise; // tick 지연 유도
      activeTicks -= 1;
    };

    const scheduler = createMemoryCandidateReconcilerScheduler({
      reconcile: mockReconcile,
      intervalMs: 10,
      logger: { info: () => {}, error: () => {} },
      setIntervalFn: setInterval,
      clearIntervalFn: clearInterval,
    });

    // 1. 스케줄러 기동 및 동시 틱 실행 시도
    scheduler.start();
    
    // 강제 interval 트리거 모사를 위해 setImmediate/setTimeout 양보
    await new Promise((resolve) => setTimeout(resolve, 25));

    // single-flight 락 덕분에 동시에 구동 중인 tick은 최대 1개여야 함
    expect(maxConcurrentTicks).toBe(1);
    expect(tickCount).toBe(1); // 대기 중이므로 1번만 구동

    // 2. tick이 완료되기 전에 stop Promise가 완료되지 않는지 확인
    let stopPromiseResolved = false;
    const stopPromise = scheduler.stop().then(() => {
      stopPromiseResolved = true;
    });

    // stopPromise가 마이크로태스크 큐를 돌도록 양보
    await new Promise((resolve) => setImmediate(resolve));
    // 아직 tick이 실행 중(tickPromise가 미해결 상태)이므로 stopPromise는 해결되지 않았어야 함
    expect(stopPromiseResolved).toBe(false);

    // 3. 이제 tick을 완료시켜 stop Promise가 정상 완료되는지 확인
    resolveTick();
    await stopPromise; // stopPromise 대기
    expect(stopPromiseResolved).toBe(true);

    // stop 호출 이후 추가 tick 구동이 멈췄는지 검증 (추가 호출 수 증가 안 됨)
    const countAfterStop = tickCount;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tickCount).toBe(countAfterStop);
  });

  // --- UAT Scenario 6: 설정 경계 ---
  it("Scenario 6: 잘못된 환경 변수 바운더리 및 Clamp UAT", async () => {
    // 1. 활성화 기능 플래그 대소문자 오타
    const config1 = resolveMemoryCandidateReconcilerConfig({
      PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_ENABLED: "True", // 대소문자 비매칭
    });
    expect(config1.enabled).toBe(false);

    const config2 = resolveMemoryCandidateReconcilerConfig({
      PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_ENABLED: "true", // 정상
    });
    expect(config2.enabled).toBe(true);

    // 2. intervalms 최소값 clamp 검증
    const config3 = resolveMemoryCandidateReconcilerConfig({
      PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_INTERVAL_MS: "5000", // 10s 미만
    });
    expect(config3.intervalMs).toBe(10000); // 10s로 clamp

    // 3. batch size 최대값 clamp 검증
    const config4 = resolveMemoryCandidateReconcilerConfig({
      PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_BATCH_SIZE: "999", // 200 초과
    });
    expect(config4.batchSize).toBe(200); // 200으로 clamp

    // 4. NaN / Infinity 등의 잘못된 값 복구력
    const config5 = resolveMemoryCandidateReconcilerConfig({
      PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_BATCH_SIZE: "NaN",
      PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_INTERVAL_MS: "Infinity",
    });
    expect(config5.batchSize).toBe(20); // 기본값 복구
    expect(config5.intervalMs).toBe(60000); // 기본값 복구
  });
});
