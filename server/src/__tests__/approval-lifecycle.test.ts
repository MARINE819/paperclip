import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvalActionIdempotencyKeys,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  actorIdentityFor,
  approvalTtlMsForRisk,
  claimApprovalIdempotency,
  completeApprovalIdempotency,
  checkApprovalIdempotency,
  computeApprovalFingerprint,
  consumeApproval,
  effectiveApprovalStatus,
  fingerprintStatus,
  requestFingerprintFor,
} from "../services/approval-lifecycle.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres approval-lifecycle tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describe("approval-lifecycle pure functions", () => {
  it("approvalTtlMsForRisk: HIGH and UNKNOWN are 15 minutes, LOW is unlimited", () => {
    expect(approvalTtlMsForRisk("HIGH")).toBe(15 * 60 * 1000);
    expect(approvalTtlMsForRisk("UNKNOWN")).toBe(15 * 60 * 1000);
    expect(approvalTtlMsForRisk("LOW")).toBeNull();
  });

  it("computeApprovalFingerprint changes when any bound field changes", () => {
    const base = { companyId: "c1", issueId: "i1", requestedByAgentId: "a1", risk: "HIGH" as const, taskText: "do the thing" };
    const same = computeApprovalFingerprint(base);
    expect(computeApprovalFingerprint(base)).toBe(same);
    expect(computeApprovalFingerprint({ ...base, taskText: "do a different thing" })).not.toBe(same);
    expect(computeApprovalFingerprint({ ...base, issueId: "i2" })).not.toBe(same);
    expect(computeApprovalFingerprint({ ...base, requestedByAgentId: "a2" })).not.toBe(same);
    expect(computeApprovalFingerprint({ ...base, risk: "UNKNOWN" })).not.toBe(same);
  });

  it("effectiveApprovalStatus: expired only for pending/revision_requested past expiresAt", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const past = new Date("2025-12-31T23:00:00Z");
    const future = new Date("2026-01-01T01:00:00Z");
    expect(effectiveApprovalStatus({ status: "pending", expiresAt: past, consumedAt: null }, now)).toBe("expired");
    expect(effectiveApprovalStatus({ status: "revision_requested", expiresAt: past, consumedAt: null }, now)).toBe("expired");
    expect(effectiveApprovalStatus({ status: "pending", expiresAt: future, consumedAt: null }, now)).toBe("pending");
    expect(effectiveApprovalStatus({ status: "pending", expiresAt: null, consumedAt: null }, now)).toBe("pending");
    expect(effectiveApprovalStatus({ status: "rejected", expiresAt: past, consumedAt: null }, now)).toBe("rejected");
    expect(effectiveApprovalStatus({ status: "cancelled", expiresAt: past, consumedAt: null }, now)).toBe("cancelled");
  });

  it("effectiveApprovalStatus: consumed only for approved + consumedAt set", () => {
    const now = new Date();
    expect(effectiveApprovalStatus({ status: "approved", expiresAt: null, consumedAt: now }, now)).toBe("consumed");
    expect(effectiveApprovalStatus({ status: "approved", expiresAt: null, consumedAt: null }, now)).toBe("approved");
  });

  it("effectiveApprovalStatus: tolerates undefined expiresAt/consumedAt (hand-stubbed rows) without throwing", () => {
    const row = { status: "pending" } as unknown as { status: string; expiresAt: Date | null; consumedAt: Date | null };
    expect(() => effectiveApprovalStatus(row)).not.toThrow();
    expect(effectiveApprovalStatus(row)).toBe("pending");
  });

  it("fingerprintStatus: not_applicable / current / stale", () => {
    expect(fingerprintStatus({ taskFingerprint: null, supersededByApprovalId: null })).toBe("not_applicable");
    expect(fingerprintStatus({ taskFingerprint: "fp", supersededByApprovalId: null })).toBe("current");
    expect(fingerprintStatus({ taskFingerprint: "fp", supersededByApprovalId: "other-id" })).toBe("stale");
  });

  it("actorIdentityFor: board_key source uses keyId, everything else uses userId", () => {
    expect(actorIdentityFor({ actor: { source: "board_key", keyId: "key-1", userId: "user-1" } })).toBe("board_key:key-1");
    expect(actorIdentityFor({ actor: { source: "session", userId: "user-1" } })).toBe("user:user-1");
    expect(actorIdentityFor({ actor: { source: "local_implicit", userId: "local-board" } })).toBe("user:local-board");
  });

  it("requestFingerprintFor: same decisionNote hashes the same, different note hashes differently", () => {
    const a = requestFingerprintFor({ decisionNote: "looks fine" });
    expect(requestFingerprintFor({ decisionNote: "looks fine" })).toBe(a);
    expect(requestFingerprintFor({ decisionNote: "different note" })).not.toBe(a);
    expect(requestFingerprintFor({ decisionNote: null })).not.toBe(a);
  });
});

describeEmbeddedPostgres("consumeApproval (embedded Postgres)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-lifecycle-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(approvalActionIdempotencyKeys);
    await db.delete(approvals);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const [company] = await db.insert(companies).values({ name: "Co", issuePrefix: `T${Math.random().toString(36).slice(2, 6).toUpperCase()}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Agent" }).returning();
    companyId = company.id;
    agentId = agent.id;
    return { company, agent };
  }

  async function seedRun() {
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId }).returning();
    return run.id;
  }

  async function seedApproval(overrides: Partial<typeof approvals.$inferInsert> = {}) {
    const [approval] = await db
      .insert(approvals)
      .values({
        companyId,
        type: "request_board_approval",
        status: "approved",
        payload: {},
        taskFingerprint: "fp-1",
        expiresAt: new Date(Date.now() + 60_000),
        ...overrides,
      })
      .returning();
    return approval;
  }

  it("consumes an approved, unexpired, matching-fingerprint approval exactly once", async () => {
    await seedCompanyAndAgent();
    const approval = await seedApproval();
    const runId = await seedRun();

    const result = await consumeApproval(db, { approvalId: approval.id, runId, expectedTaskFingerprint: "fp-1" });

    expect(result.outcome).toBe("consumed");
    expect(result.approval?.consumedByRunId).toBe(runId);
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approval.id));
    expect(row.consumedAt).not.toBeNull();
    expect(row.consumedByRunId).toBe(runId);
  });

  it("rejects consuming an approval that is not approved", async () => {
    await seedCompanyAndAgent();
    const approval = await seedApproval({ status: "pending" });
    const runId = await seedRun();

    const result = await consumeApproval(db, { approvalId: approval.id, runId, expectedTaskFingerprint: "fp-1" });
    expect(result.outcome).toBe("approval_not_approved");
  });

  it("consumes an approved approval even if initial decision expiresAt has already passed", async () => {
    await seedCompanyAndAgent();
    const approval = await seedApproval({ expiresAt: new Date(Date.now() - 1000) });
    const runId = await seedRun();

    const result = await consumeApproval(db, { approvalId: approval.id, runId, expectedTaskFingerprint: "fp-1" });
    expect(result.outcome).toBe("consumed");
    expect(result.approval?.consumedByRunId).toBe(runId);
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approval.id));
    expect(row.consumedAt).not.toBeNull();
    expect(row.consumedByRunId).toBe(runId);
  });

  it("consumes an approved approval when expiresAt is null", async () => {
    await seedCompanyAndAgent();
    const approval = await seedApproval({ expiresAt: null });
    const runId = await seedRun();

    const result = await consumeApproval(db, { approvalId: approval.id, runId, expectedTaskFingerprint: "fp-1" });
    expect(result.outcome).toBe("consumed");
    expect(result.approval?.consumedByRunId).toBe(runId);
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approval.id));
    expect(row.consumedAt).not.toBeNull();
    expect(row.consumedByRunId).toBe(runId);
  });

  it("rejects consuming an approval with a mismatched fingerprint", async () => {
    await seedCompanyAndAgent();
    const approval = await seedApproval();
    const runId = await seedRun();

    const result = await consumeApproval(db, { approvalId: approval.id, runId, expectedTaskFingerprint: "different-fp" });
    expect(result.outcome).toBe("fingerprint_mismatch");
  });

  it("rejects consuming a superseded approval", async () => {
    await seedCompanyAndAgent();
    const newer = await seedApproval();
    const approval = await seedApproval({ supersededByApprovalId: newer.id });
    const runId = await seedRun();

    const result = await consumeApproval(db, { approvalId: approval.id, runId, expectedTaskFingerprint: "fp-1" });
    expect(result.outcome).toBe("approval_superseded");
  });

  it("treats a retry from the SAME runId as an idempotent success", async () => {
    await seedCompanyAndAgent();
    const approval = await seedApproval();
    const runId = await seedRun();

    const first = await consumeApproval(db, { approvalId: approval.id, runId, expectedTaskFingerprint: "fp-1" });
    const second = await consumeApproval(db, { approvalId: approval.id, runId, expectedTaskFingerprint: "fp-1" });

    expect(first.outcome).toBe("consumed");
    expect(second.outcome).toBe("already_consumed_same_run");
    expect(second.approval?.consumedByRunId).toBe(runId);
  });

  it("rejects a DIFFERENT runId from reusing an already-consumed approval, even with a matching fingerprint", async () => {
    await seedCompanyAndAgent();
    const approval = await seedApproval();
    const runA = await seedRun();
    const runB = await seedRun();

    const first = await consumeApproval(db, { approvalId: approval.id, runId: runA, expectedTaskFingerprint: "fp-1" });
    const second = await consumeApproval(db, { approvalId: approval.id, runId: runB, expectedTaskFingerprint: "fp-1" });

    expect(first.outcome).toBe("consumed");
    expect(second.outcome).toBe("already_consumed_other_run");
    expect(second.approval?.consumedByRunId).toBe(runA);
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approval.id));
    expect(row.consumedByRunId).toBe(runA);
  });

  it("race: two concurrent runs consuming the same approval — exactly one 'consumed', the other 'already_consumed_other_run'", async () => {
    await seedCompanyAndAgent();
    const approval = await seedApproval();
    const runA = await seedRun();
    const runB = await seedRun();

    const [resultA, resultB] = await Promise.all([
      consumeApproval(db, { approvalId: approval.id, runId: runA, expectedTaskFingerprint: "fp-1" }),
      consumeApproval(db, { approvalId: approval.id, runId: runB, expectedTaskFingerprint: "fp-1" }),
    ]);

    const outcomes = [resultA.outcome, resultB.outcome].sort();
    expect(outcomes).toEqual(["already_consumed_other_run", "consumed"]);
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approval.id));
    // Exactly one of the two runIds ended up recorded — never both, never neither.
    expect([runA, runB]).toContain(row.consumedByRunId);
  });

  it("race: state changes between an external check and consume — consume atomically re-validates and rejects", async () => {
    await seedCompanyAndAgent();
    const approval = await seedApproval();
    const runId = await seedRun();

    // Simulate another transaction invalidating the approval (e.g. it expired
    // or was superseded) in the gap between some caller's earlier read and
    // this consume call — consumeApproval must re-check atomically, not
    // trust a stale earlier read.
    await db.update(approvals).set({ status: "rejected" }).where(eq(approvals.id, approval.id));

    const result = await consumeApproval(db, { approvalId: approval.id, runId, expectedTaskFingerprint: "fp-1" });
    expect(result.outcome).toBe("approval_not_approved");
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approval.id));
    expect(row.consumedAt).toBeNull();
  });
});

describeEmbeddedPostgres("approval action idempotency claim/complete/check (embedded Postgres)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-idempotency-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(approvalActionIdempotencyKeys);
    await db.delete(approvals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const [company] = await db.insert(companies).values({ name: "Co", issuePrefix: `T${Math.random().toString(36).slice(2, 6).toUpperCase()}` }).returning();
    companyId = company.id;
    return company;
  }

  async function seedApproval() {
    const [approval] = await db.insert(approvals).values({ companyId, type: "request_board_approval", status: "pending", payload: {} }).returning();
    return approval;
  }

  it("claim wins for the first caller and is completed atomically", async () => {
    await seedCompany();
    const approval = await seedApproval();

    const claim = await db.transaction(async (tx) => {
      const c = await claimApprovalIdempotency(tx as unknown as Db, {
        companyId, actorIdentity: "user:u1", idempotencyKey: "k1", approvalId: approval.id, action: "approve", requestFingerprint: "rf1",
      });
      if (c.kind === "won") {
        await completeApprovalIdempotency(tx as unknown as Db, { claimId: c.claimId, httpStatus: 200, body: { ok: true } });
      }
      return c;
    });

    expect(claim.kind).toBe("won");
    const lookup = await checkApprovalIdempotency(db, {
      actorIdentity: "user:u1", idempotencyKey: "k1", approvalId: approval.id, action: "approve", requestFingerprint: "rf1",
    });
    expect(lookup).toEqual({ kind: "replay", httpStatus: 200, body: { ok: true } });
  });

  it("a later request with the same key replays the completed result without being told to redo the work", async () => {
    await seedCompany();
    const approval = await seedApproval();

    await db.transaction(async (tx) => {
      const c = await claimApprovalIdempotency(tx as unknown as Db, {
        companyId, actorIdentity: "user:u1", idempotencyKey: "k1", approvalId: approval.id, action: "approve", requestFingerprint: "rf1",
      });
      if (c.kind === "won") {
        await completeApprovalIdempotency(tx as unknown as Db, { claimId: c.claimId, httpStatus: 200, body: { approved: true } });
      }
    });

    const replay = await checkApprovalIdempotency(db, {
      actorIdentity: "user:u1", idempotencyKey: "k1", approvalId: approval.id, action: "approve", requestFingerprint: "rf1",
    });
    expect(replay).toEqual({ kind: "replay", httpStatus: 200, body: { approved: true } });
  });

  it("reusing the same key with a different approvalId/action/body is a conflict, not a silent new entry", async () => {
    await seedCompany();
    const approval1 = await seedApproval();
    const approval2 = await seedApproval();

    await db.transaction(async (tx) => {
      const c = await claimApprovalIdempotency(tx as unknown as Db, {
        companyId, actorIdentity: "user:u1", idempotencyKey: "same-key", approvalId: approval1.id, action: "approve", requestFingerprint: "rf1",
      });
      if (c.kind === "won") {
        await completeApprovalIdempotency(tx as unknown as Db, { claimId: c.claimId, httpStatus: 200, body: {} });
      }
    });

    const differentApproval = await checkApprovalIdempotency(db, {
      actorIdentity: "user:u1", idempotencyKey: "same-key", approvalId: approval2.id, action: "approve", requestFingerprint: "rf1",
    });
    expect(differentApproval.kind).toBe("key_reused_with_different_request");

    const differentAction = await checkApprovalIdempotency(db, {
      actorIdentity: "user:u1", idempotencyKey: "same-key", approvalId: approval1.id, action: "reject", requestFingerprint: "rf1",
    });
    expect(differentAction.kind).toBe("key_reused_with_different_request");

    const differentBody = await checkApprovalIdempotency(db, {
      actorIdentity: "user:u1", idempotencyKey: "same-key", approvalId: approval1.id, action: "approve", requestFingerprint: "different-rf",
    });
    expect(differentBody.kind).toBe("key_reused_with_different_request");
  });

  it("different actors never share a cache entry even with the identical idempotencyKey", async () => {
    await seedCompany();
    const approval = await seedApproval();

    await db.transaction(async (tx) => {
      const c = await claimApprovalIdempotency(tx as unknown as Db, {
        companyId, actorIdentity: "user:u1", idempotencyKey: "shared-key", approvalId: approval.id, action: "approve", requestFingerprint: "rf1",
      });
      if (c.kind === "won") {
        await completeApprovalIdempotency(tx as unknown as Db, { claimId: c.claimId, httpStatus: 200, body: { by: "u1" } });
      }
    });

    const otherActor = await checkApprovalIdempotency(db, {
      actorIdentity: "user:u2", idempotencyKey: "shared-key", approvalId: approval.id, action: "approve", requestFingerprint: "rf1",
    });
    expect(otherActor.kind).toBe("none");
  });

  it("race: two concurrent first-time claims for the same (actor, key) — exactly one wins, the loser replays the winner's committed result and never claims its own", async () => {
    await seedCompany();
    const approval = await seedApproval();

    async function attempt(label: string) {
      return db.transaction(async (tx) => {
        const c = await claimApprovalIdempotency(tx as unknown as Db, {
          companyId, actorIdentity: "user:u1", idempotencyKey: "race-key", approvalId: approval.id, action: "approve", requestFingerprint: "rf1",
        });
        if (c.kind === "won") {
          await completeApprovalIdempotency(tx as unknown as Db, { claimId: c.claimId, httpStatus: 200, body: { winner: label } });
        }
        return c;
      });
    }

    const [claimA, claimB] = await Promise.all([attempt("A"), attempt("B")]);
    const kinds = [claimA.kind, claimB.kind].sort();
    // Exactly one "won"; the other is either "lost_replay" (if it unblocked
    // after the winner committed) — never two "won"s, and the loser must
    // never see a still-"reserved" (incomplete) row.
    expect(kinds.filter((k) => k === "won")).toHaveLength(1);
    expect(kinds).toContain("lost_replay");

    const winnerLabel = claimA.kind === "won" ? "A" : "B";
    const loser = claimA.kind === "won" ? claimB : claimA;
    if (loser.kind === "lost_replay") {
      expect(loser.body).toEqual({ winner: winnerLabel });
    }

    // Only one row ever exists for this (actor, key) — the unique index held.
    const rows = await db.select().from(approvalActionIdempotencyKeys);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("completed");
  });
});
