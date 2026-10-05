// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  taskAuthorizationEnvelopeConsumptions,
  taskAuthorizationEnvelopes,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  authorizeAndConsumeEnvelope,
  extractGoogleSheetsScope,
} from "../services/task-authorization-envelope.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("extractGoogleSheetsScope (pure)", () => {
  it("extracts spreadsheetId and an unquoted sheet name", () => {
    expect(extractGoogleSheetsScope({ spreadsheetId: "sheet-1", range: "Sheet1!A1:D20" }))
      .toEqual({ spreadsheetId: "sheet-1", sheetName: "Sheet1" });
  });

  it("extracts a quoted sheet name containing a space", () => {
    expect(extractGoogleSheetsScope({ spreadsheetId: "sheet-1", range: "'Sheet 1'!A1:D20" }))
      .toEqual({ spreadsheetId: "sheet-1", sheetName: "Sheet 1" });
  });

  it("never lets Sheet1 match an allow-list entry for Sheet10 (prefix-comparison trap)", () => {
    const a = extractGoogleSheetsScope({ spreadsheetId: "s", range: "Sheet1!A1:B2" });
    const b = extractGoogleSheetsScope({ spreadsheetId: "s", range: "Sheet10!A1:B2" });
    expect(a?.sheetName).toBe("Sheet1");
    expect(b?.sheetName).toBe("Sheet10");
    expect(a?.sheetName).not.toBe(b?.sheetName);
  });

  it("fails closed when there is no '!' separator", () => {
    expect(extractGoogleSheetsScope({ spreadsheetId: "sheet-1", range: "A1:D20" })).toBeNull();
  });

  it("fails closed on malformed quoting", () => {
    expect(extractGoogleSheetsScope({ spreadsheetId: "sheet-1", range: "'Sheet 1!A1:D20" })).toBeNull();
  });

  it("fails closed when spreadsheetId or range is missing", () => {
    expect(extractGoogleSheetsScope({ range: "Sheet1!A1" })).toBeNull();
    expect(extractGoogleSheetsScope({ spreadsheetId: "sheet-1" })).toBeNull();
    expect(extractGoogleSheetsScope(null)).toBeNull();
  });
});

describeEmbeddedPostgres("authorizeAndConsumeEnvelope (embedded Postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-envelope-tool-gateway-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(taskAuthorizationEnvelopeConsumptions);
    await db.delete(taskAuthorizationEnvelopes);
    await db.delete(toolCatalogEntries);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(overrides: {
    catalogRiskLevel?: string;
    catalogStatus?: string;
    transport?: string;
    sourceTemplateKey?: string | null;
    toolName?: string;
  } = {}) {
    const company = await db.insert(companies).values({
      name: `Co ${randomUUID().slice(0, 8)}`,
      issuePrefix: `T${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning().then((r) => r[0]!);
    const agent = await db.insert(agents).values({
      companyId: company.id,
      name: `Agent ${randomUUID()}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning().then((r) => r[0]!);
    const issue = await db.insert(issues).values({
      companyId: company.id,
      title: "Sheet update work",
      status: "in_progress",
      assigneeAgentId: agent.id,
    }).returning().then((r) => r[0]!);
    const run = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent.id,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: { issueId: issue.id },
    }).returning().then((r) => r[0]!);

    const application = await db.insert(toolApplications).values({
      companyId: company.id,
      applicationKey: `google-sheets-${randomUUID().slice(0, 8)}`,
      name: "Google Sheets",
      type: "mcp_stdio",
      status: "active",
    }).returning().then((r) => r[0]!);
    const connection = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application.id,
      name: "Google Sheets connection",
      uid: `test/${randomUUID()}`,
      transport: (overrides.transport ?? "local_stdio") as "local_stdio",
      status: "active",
      enabled: true,
      healthStatus: "ok",
      config: overrides.sourceTemplateKey === null
        ? {}
        : { sourceTemplateKey: overrides.sourceTemplateKey ?? "google-sheets" },
    }).returning().then((r) => r[0]!);
    const catalogEntry = await db.insert(toolCatalogEntries).values({
      companyId: company.id,
      applicationId: application.id,
      connectionId: connection.id,
      entryKind: "tool",
      name: overrides.toolName ?? "append_rows",
      toolName: overrides.toolName ?? "append_rows",
      title: "Append rows",
      riskLevel: (overrides.catalogRiskLevel ?? "write") as "write",
      isReadOnly: false,
      isWrite: true,
      status: (overrides.catalogStatus ?? "active") as "active",
      versionHash: randomUUID(),
      schemaHash: randomUUID(),
    }).returning().then((r) => r[0]!);

    return { company, agent, issue, run, application, connection, catalogEntry };
  }

  async function seedEnvelope(
    fixture: Awaited<ReturnType<typeof seedFixture>>,
    overrides: Partial<typeof taskAuthorizationEnvelopes.$inferInsert> = {},
  ) {
    return db.insert(taskAuthorizationEnvelopes).values({
      companyId: fixture.company.id,
      issueId: fixture.issue.id,
      agentId: fixture.agent.id,
      level: "safe_mutation",
      riskCeiling: "LOW",
      allowedResources: [{ type: "google_sheet", spreadsheetId: "sheet-1", sheetName: "Sheet1" }],
      expiresAt: new Date(Date.now() + 60_000),
      issuedByUserId: "board-user",
      ...overrides,
    }).returning().then((r) => r[0]!);
  }

  function paramsFor(fixture: Awaited<ReturnType<typeof seedFixture>>, extra: Record<string, unknown> = {}) {
    return {
      companyId: fixture.company.id,
      issueId: fixture.issue.id,
      agentId: fixture.agent.id,
      runId: fixture.run.id,
      toolCatalogEntryId: fixture.catalogEntry.id,
      toolName: fixture.catalogEntry.name,
      parameters: { spreadsheetId: "sheet-1", range: "Sheet1!A1:B2", values: [["a", "b"]], ...extra },
    };
  }

  it("allows append_rows with matching scope and consumes one operation", async () => {
    const fixture = await seedFixture();
    await seedEnvelope(fixture);

    const result = await authorizeAndConsumeEnvelope(db, paramsFor(fixture));
    expect(result.outcome).toBe("allowed");

    const [row] = await db.select().from(taskAuthorizationEnvelopes).where(eq(taskAuthorizationEnvelopes.companyId, fixture.company.id));
    expect(row.operationsConsumed).toBe(1);
  });

  it("allows update_values with matching scope", async () => {
    const fixture = await seedFixture({ toolName: "update_values" });
    await seedEnvelope(fixture);

    const result = await authorizeAndConsumeEnvelope(db, paramsFor(fixture));
    expect(result.outcome).toBe("allowed");
  });

  it("denies a different spreadsheetId", async () => {
    const fixture = await seedFixture();
    await seedEnvelope(fixture);

    const result = await authorizeAndConsumeEnvelope(
      db,
      paramsFor(fixture, { spreadsheetId: "sheet-OTHER" }),
    );
    expect(result.outcome).toBe("denied");
  });

  it("denies a different sheet name, including the Sheet1/Sheet10 prefix trap", async () => {
    const fixture = await seedFixture();
    await seedEnvelope(fixture);

    const result = await authorizeAndConsumeEnvelope(
      db,
      paramsFor(fixture, { range: "Sheet10!A1:B2" }),
    );
    expect(result.outcome).toBe("denied");
  });

  it("denies when the range has no parseable sheet name", async () => {
    const fixture = await seedFixture();
    await seedEnvelope(fixture);

    const result = await authorizeAndConsumeEnvelope(db, paramsFor(fixture, { range: "A1:B2" }));
    expect(result.outcome).toBe("denied");
  });

  it("denies the same tool name arriving from a different (non-google-sheets) connection", async () => {
    const fixture = await seedFixture({ sourceTemplateKey: "some-other-app" });
    await seedEnvelope(fixture);

    const result = await authorizeAndConsumeEnvelope(db, paramsFor(fixture));
    expect(result.outcome).toBe("denied");
  });

  it("denies a remote (non-local_stdio) connection even with the right tool name", async () => {
    const fixture = await seedFixture({ transport: "mcp_remote" });
    await seedEnvelope(fixture);

    const result = await authorizeAndConsumeEnvelope(db, paramsFor(fixture));
    expect(result.outcome).toBe("denied");
  });

  it("denies a quarantined/inactive catalog entry", async () => {
    const fixture = await seedFixture({ catalogStatus: "quarantined" });
    await seedEnvelope(fixture);

    const result = await authorizeAndConsumeEnvelope(db, paramsFor(fixture));
    expect(result.outcome).toBe("denied");
  });

  it("denies an expired envelope", async () => {
    const fixture = await seedFixture();
    await seedEnvelope(fixture, { expiresAt: new Date(Date.now() - 1_000) });

    const result = await authorizeAndConsumeEnvelope(db, paramsFor(fixture));
    expect(result.outcome).toBe("denied");
  });

  it("denies a revoked envelope", async () => {
    const fixture = await seedFixture();
    const envelope = await seedEnvelope(fixture);
    await db.update(taskAuthorizationEnvelopes)
      .set({ revokedAt: new Date(), revokedByUserId: "board-user" })
      .where(eq(taskAuthorizationEnvelopes.id, envelope.id));

    const result = await authorizeAndConsumeEnvelope(db, paramsFor(fixture));
    expect(result.outcome).toBe("denied");
  });

  it("denies when the calling agent does not match the envelope's bound agent", async () => {
    const fixture = await seedFixture();
    await seedEnvelope(fixture);
    const otherAgent = await db.insert(agents).values({
      companyId: fixture.company.id,
      name: `Other agent ${randomUUID()}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning().then((r) => r[0]!);

    const result = await authorizeAndConsumeEnvelope(db, { ...paramsFor(fixture), agentId: otherAgent.id });
    expect(result.outcome).toBe("denied");
  });

  it("denies once maxOperations is reached, atomically under concurrency", async () => {
    const fixture = await seedFixture();
    await seedEnvelope(fixture, { maxOperations: 1 });

    const [first, second] = await Promise.all([
      authorizeAndConsumeEnvelope(db, { ...paramsFor(fixture, { range: "Sheet1!A1:A1" }) }),
      authorizeAndConsumeEnvelope(db, { ...paramsFor(fixture, { range: "Sheet1!A2:A2" }) }),
    ]);
    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(["allowed", "denied"]);

    const [row] = await db.select().from(taskAuthorizationEnvelopes).where(eq(taskAuthorizationEnvelopes.companyId, fixture.company.id));
    expect(row.operationsConsumed).toBe(1);
  });

  it("does not double-consume a genuine retry of the identical action", async () => {
    const fixture = await seedFixture();
    await seedEnvelope(fixture);

    const params = paramsFor(fixture);
    const first = await authorizeAndConsumeEnvelope(db, params);
    const retry = await authorizeAndConsumeEnvelope(db, params);
    expect(first.outcome).toBe("allowed");
    expect(retry.outcome).toBe("allowed");

    const [row] = await db.select().from(taskAuthorizationEnvelopes).where(eq(taskAuthorizationEnvelopes.companyId, fixture.company.id));
    expect(row.operationsConsumed).toBe(1);
  });

  it("consumes a separate operation for a different action from the same run", async () => {
    const fixture = await seedFixture();
    await seedEnvelope(fixture, { maxOperations: 5 });

    await authorizeAndConsumeEnvelope(db, paramsFor(fixture, { range: "Sheet1!A1:A1" }));
    await authorizeAndConsumeEnvelope(db, paramsFor(fixture, { range: "Sheet1!A2:A2" }));

    const [row] = await db.select().from(taskAuthorizationEnvelopes).where(eq(taskAuthorizationEnvelopes.companyId, fixture.company.id));
    expect(row.operationsConsumed).toBe(2);
  });

  // ── Security regression: destructive tools are never envelope-eligible. ──
  it("never authorizes a destructive tool (e.g. clear_values), regardless of catalog risk-level tampering attempts", async () => {
    const fixture = await seedFixture({ toolName: "clear_values", catalogRiskLevel: "destructive" });
    await seedEnvelope(fixture);

    const result = await authorizeAndConsumeEnvelope(db, paramsFor(fixture));
    expect(result.outcome).toBe("denied");
  });

  it("never authorizes delete_rows even if somehow mislabeled as write-risk in the catalog", async () => {
    // Defense in depth: even if riskLevel were wrong, the tool name itself
    // is not in the supported allow-list, so this must still deny.
    const fixture = await seedFixture({ toolName: "delete_rows", catalogRiskLevel: "write" });
    await seedEnvelope(fixture);

    const result = await authorizeAndConsumeEnvelope(db, paramsFor(fixture));
    expect(result.outcome).toBe("denied");
  });

  it("denies an unsupported tool name outright", async () => {
    const fixture = await seedFixture({ toolName: "read_values", catalogRiskLevel: "read" });
    await seedEnvelope(fixture);

    const result = await authorizeAndConsumeEnvelope(db, paramsFor(fixture));
    expect(result.outcome).toBe("denied");
  });

  it("fails closed when the execution context is incomplete (no runId)", async () => {
    const fixture = await seedFixture();
    await seedEnvelope(fixture);

    const result = await authorizeAndConsumeEnvelope(db, { ...paramsFor(fixture), runId: null });
    expect(result.outcome).toBe("denied");
  });

  it("denies when no envelope exists at all for this company/issue/agent", async () => {
    const fixture = await seedFixture();
    // No envelope seeded.
    const result = await authorizeAndConsumeEnvelope(db, paramsFor(fixture));
    expect(result.outcome).toBe("denied");
  });

  it("denies when the envelope's level is not safe_mutation", async () => {
    const fixture = await seedFixture();
    await seedEnvelope(fixture, { level: "read_only" });

    const result = await authorizeAndConsumeEnvelope(db, paramsFor(fixture));
    expect(result.outcome).toBe("denied");
  });
});
