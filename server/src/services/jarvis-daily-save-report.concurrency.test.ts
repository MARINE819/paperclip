import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, approvals, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { generateDailyGitSaveReportAndApproval } from "./jarvis-daily-save-report.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping SYNC-02 idle-report PostgreSQL concurrency tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres(
  "generateDailyGitSaveReportAndApproval -- real PostgreSQL integration (Stage A)",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-sync02-idle-concurrency-");
      db = createDb(tempDb.connectionString);
    }, 20_000);

    afterEach(async () => {
      await db.delete(approvals);
      await db.delete(heartbeatRuns);
      await db.delete(agents);
      await db.delete(companies);
    });

    afterAll(async () => {
      await tempDb?.cleanup();
    });

    async function seedCompany(name = "Paperclip") {
      const [company] = await db
        .insert(companies)
        .values({
          name,
          issuePrefix: `J${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
          requireBoardApprovalForNewAgents: false,
        })
        .returning();
      return company;
    }

    async function seedAgent(companyId: string, name: string, overrides: Record<string, unknown> = {}) {
      const [agent] = await db
        .insert(agents)
        .values({ companyId, name, status: "idle", ...overrides })
        .returning();
      return agent;
    }

    function writeFakeCollectorOutput(args: readonly string[]) {
      return (async () => {
        const { writeFile } = await import("node:fs/promises");
        const jsonOutPath = args[args.indexOf("--json-out") + 1] as string;
        const reportOutPath = args[args.indexOf("--report-out") + 1] as string;
        await writeFile(
          jsonOutPath,
          JSON.stringify({
            kstWindow: { dateKst: "2026-11-02" },
            summaryCounts: { saveCandidateCount: 0, needsReviewCount: 0, excludedCount: 0 },
            gitSaveHandOff: { readyForPrepare: false },
          }),
          "utf8",
        );
        await writeFile(reportOutPath, "# concurrency test report", "utf8");
      })();
    }

    // The artificial delay is here only to widen the window in which both
    // requests can genuinely contend for the same advisory lock -- it does
    // NOT guarantee (and this test does not assert) that both collector
    // phases overlap. The lock in jarvis-daily-save-report.ts is acquired
    // again right before the final dedup re-check / insert, independent of
    // how long each request's own collector step took, so lock-level
    // serialization is correctly exercised even if the two collector steps
    // happen to run one after the other.
    function makeDelayedExecFileImpl() {
      return (async (_cmd: string, args: readonly string[]) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await writeFakeCollectorOutput(args);
        return { stdout: "", stderr: "" };
      }) as any;
    }

    function makeOkExecFileImpl() {
      return (async (_cmd: string, args: readonly string[]) => {
        await writeFakeCollectorOutput(args);
        return { stdout: "", stderr: "" };
      }) as any;
    }

    it("real PostgreSQL advisory lock allows exactly one approval when two requests race for the same idle window", async () => {
      const realNow = Date.now();
      const now = () => new Date(realNow);
      const idleSinceAt = new Date(realNow - 31 * 60_000); // 31 real minutes ago

      const company = await seedCompany();
      const jarvis = await seedAgent(company.id, "JARVIS");
      // Establishes the idle anchor via a REAL row, well outside the
      // 10-second "just created" buffer relative to `now`.
      await db.insert(heartbeatRuns).values({
        companyId: company.id,
        agentId: jarvis.id,
        status: "succeeded",
        lastUsefulActionAt: idleSinceAt,
        createdAt: new Date(realNow - 32 * 60_000),
      });

      // Proves the two requests were genuinely dispatched together, not
      // one-after-the-other: Promise.all evaluates both call expressions
      // synchronously, back to back, before either can resolve, so a
      // dispatch-time marker recorded as the very first action inside each
      // call lands within a few ms of the other regardless of what happens
      // afterward (the delayed collector, lock contention, etc.). This is
      // kept deliberately separate from the DB-level serialization proof
      // below (outcome pairing + row count), which is what actually shows
      // the advisory lock did its job.
      const dispatchMarks: number[] = [];
      function dispatchedCall() {
        dispatchMarks.push(Date.now());
        return generateDailyGitSaveReportAndApproval({
          db,
          companyId: company.id,
          jarvisAgentId: jarvis.id,
          repoRoot: "/fake/repo",
          source: "sync02_idle_30min",
          idleSinceAt,
          now,
          collectorDeps: { execFileImpl: makeDelayedExecFileImpl() },
        });
      }

      const [resultA, resultB] = await Promise.all([dispatchedCall(), dispatchedCall()]);

      expect(dispatchMarks).toHaveLength(2);
      expect(Math.abs(dispatchMarks[0] - dispatchMarks[1])).toBeLessThan(50);

      // The actual proof that the advisory lock serialized the two
      // requests: exactly one creates a fresh approval, the other finds it
      // via dedup -- never two "created", never two rows.
      const outcomes = [resultA.outcome, resultB.outcome].sort();
      expect(outcomes).toEqual(["created", "deduplicated"]);

      const rows = await db.select().from(approvals).where(eq(approvals.companyId, company.id));
      expect(rows).toHaveLength(1);
      expect((rows[0].payload as any).idleSinceAt).toBe(idleSinceAt.toISOString());
    }, 15_000);

    it("cancels report generation (outcome 'aborted_activity_resumed') when a real heartbeat run is active, and creates no approval", async () => {
      const realNow = Date.now();
      const company = await seedCompany();
      const jarvis = await seedAgent(company.id, "JARVIS");
      // A real "running" heartbeat_runs row -- computeCompanyActivitySignal
      // must find this via a genuine SQL query, not a mock.
      await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: jarvis.id, status: "running" });

      const output = await generateDailyGitSaveReportAndApproval({
        db,
        companyId: company.id,
        jarvisAgentId: jarvis.id,
        repoRoot: "/fake/repo",
        source: "sync02_idle_30min",
        idleSinceAt: new Date(realNow - 31 * 60_000),
        now: () => new Date(realNow),
        collectorDeps: { execFileImpl: makeOkExecFileImpl() },
      });

      expect(output.outcome).toBe("aborted_activity_resumed");
      expect(output.approvalId).toBeNull();

      const rows = await db.select().from(approvals).where(eq(approvals.companyId, company.id));
      expect(rows).toHaveLength(0);
    });
  },
);
