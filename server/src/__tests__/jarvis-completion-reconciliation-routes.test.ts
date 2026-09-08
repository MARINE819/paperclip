import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const reconcileDelegatedChildCompletion = vi.hoisted(() => vi.fn());
vi.mock("../services/jarvis-completion-reconciler.js", () => ({ reconcileDelegatedChildCompletion }));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("GET /issues/:id/jarvis-delegation-reconciliation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-jarvis-reconciliation-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    reconcileDelegatedChildCompletion.mockReset();
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany(name: string) {
    const [company] = await db.insert(companies).values({
      name,
      issuePrefix: `R${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
    }).returning();
    return company;
  }

  async function seedAgent(companyId: string, name: string) {
    const [agent] = await db.insert(agents).values({ companyId, name, status: "idle" }).returning();
    return agent;
  }

  async function seedParent(companyId: string, assigneeAgentId: string) {
    const [issue] = await db.insert(issues).values({
      companyId,
      title: "Delegated parent",
      status: "in_progress",
      assigneeAgentId,
    }).returning();
    return issue;
  }

  it("returns the structured reconciliation result to the Human Board", async () => {
    const company = await seedCompany("Company A");
    const jarvis = await seedAgent(company.id, "JARVIS");
    const parent = await seedParent(company.id, jarvis.id);
    const result = { outcome: "ready_for_jarvis_review", parentIssueId: parent.id, childIssueId: "child" };
    reconcileDelegatedChildCompletion.mockResolvedValue(result);

    const response = await request(createApp())
      .get(`/api/issues/${parent.id}/jarvis-delegation-reconciliation?resolvedChildIssueId=child`)
      .expect(200);

    expect(response.body).toEqual(result);
    expect(reconcileDelegatedChildCompletion).toHaveBeenCalledWith(db, {
      companyId: company.id,
      parentIssueId: parent.id,
      resolvedChildIssueId: "child",
    });
  });

  it("allows only the agent assigned to the parent Issue", async () => {
    const company = await seedCompany("Company A");
    const jarvis = await seedAgent(company.id, "JARVIS");
    const otherAgent = await seedAgent(company.id, "Other Agent");
    const parent = await seedParent(company.id, jarvis.id);
    reconcileDelegatedChildCompletion.mockResolvedValue({ outcome: "child_not_terminal" });
    const runId = "00000000-0000-0000-0000-000000000000";
    const jarvisToken = createLocalAgentJwt(jarvis.id, company.id, "codex_local", runId)!;
    const otherToken = createLocalAgentJwt(otherAgent.id, company.id, "codex_local", runId)!;

    await request(createApp())
      .get(`/api/issues/${parent.id}/jarvis-delegation-reconciliation?resolvedChildIssueId=child`)
      .set("Authorization", `Bearer ${jarvisToken}`)
      .expect(200);
    await request(createApp())
      .get(`/api/issues/${parent.id}/jarvis-delegation-reconciliation?resolvedChildIssueId=child`)
      .set("Authorization", `Bearer ${otherToken}`)
      .expect(403);

    expect(reconcileDelegatedChildCompletion).toHaveBeenCalledTimes(1);
  });

  it("hides the parent Issue from a cross-company agent before reconciliation", async () => {
    const companyA = await seedCompany("Company A");
    const companyB = await seedCompany("Company B");
    const jarvis = await seedAgent(companyB.id, "JARVIS B");
    const foreignAgent = await seedAgent(companyA.id, "Foreign Agent");
    const parent = await seedParent(companyB.id, jarvis.id);
    const token = createLocalAgentJwt(
      foreignAgent.id,
      companyA.id,
      "codex_local",
      "00000000-0000-0000-0000-000000000000",
    )!;

    await request(createApp())
      .get(`/api/issues/${parent.id}/jarvis-delegation-reconciliation?resolvedChildIssueId=child`)
      .set("Authorization", `Bearer ${token}`)
      .expect(404);

    expect(reconcileDelegatedChildCompletion).not.toHaveBeenCalled();
  });

  it("requires resolvedChildIssueId", async () => {
    const company = await seedCompany("Company A");
    const jarvis = await seedAgent(company.id, "JARVIS");
    const parent = await seedParent(company.id, jarvis.id);

    await request(createApp())
      .get(`/api/issues/${parent.id}/jarvis-delegation-reconciliation`)
      .expect(400);

    expect(reconcileDelegatedChildCompletion).not.toHaveBeenCalled();
  });

  it("is a repeatable read that does not mutate Issues", async () => {
    const company = await seedCompany("Company A");
    const jarvis = await seedAgent(company.id, "JARVIS");
    const parent = await seedParent(company.id, jarvis.id);
    const result = { outcome: "missing_evidence", parentIssueId: parent.id, childIssueId: "child" };
    reconcileDelegatedChildCompletion.mockResolvedValue(result);
    const app = createApp();

    const first = await request(app)
      .get(`/api/issues/${parent.id}/jarvis-delegation-reconciliation?resolvedChildIssueId=child`)
      .expect(200);
    const second = await request(app)
      .get(`/api/issues/${parent.id}/jarvis-delegation-reconciliation?resolvedChildIssueId=child`)
      .expect(200);

    expect(first.body).toEqual(second.body);
    const [storedParent] = await db.select().from(issues);
    expect(storedParent).toMatchObject({ id: parent.id, status: "in_progress", assigneeAgentId: jarvis.id });
  });
});
