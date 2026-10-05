import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  agentApiKeys,
  agents,
  authUsers,
  boardApiKeys,
  companyMemberships,
  heartbeatRuns,
  instanceUserRoles,
} from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";

const TOKEN = "pcp_board_approval-only-test-token";
const KEY_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createSelectChain(rowsForTable: (table: unknown) => unknown[]) {
  return {
    from(table: unknown) {
      return {
        where() {
          return Promise.resolve(rowsForTable(table));
        },
      };
    },
  };
}

function createDb(boardKeyRow: Record<string, unknown> | null) {
  return {
    select: () =>
      createSelectChain((table) => {
        if (table === boardApiKeys) return boardKeyRow ? [boardKeyRow] : [];
        if (table === authUsers) return [{ id: USER_ID, name: "Mobile Board User", email: "board@example.com" }];
        if (table === companyMemberships) return [];
        if (table === instanceUserRoles) return [];
        if (table === agentApiKeys) return [];
        if (table === agents) return [];
        if (table === heartbeatRuns) return [];
        return [];
      }),
    update: () => ({
      set() {
        return {
          where() {
            return Promise.resolve([]);
          },
        };
      },
    }),
    insert: () => ({
      values() {
        return Promise.resolve([]);
      },
    }),
  } as any;
}

function createApp(db: any) {
  const app = express();
  app.use(express.json());
  app.use(
    actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: async () => null,
    }),
  );

  // Stub handlers at the exact production paths (mirrors approvals.ts /
  // access.ts / issues.ts / company routes), so this test exercises the
  // real actorMiddleware short-circuit against the real path shapes without
  // needing to stand up every real router and its service dependencies.
  const api = express.Router();
  api.get("/companies/:companyId/approvals", (req, res) => res.json({ ok: true }));
  api.get("/approvals/:id", (req, res) => res.json({ ok: true, actor: req.actor }));
  api.get("/approvals/:id/issues", (req, res) => res.json({ ok: true }));
  api.get("/approvals/:id/comments", (req, res) => res.json({ ok: true }));
  api.post("/approvals/:id/approve", (req, res) => res.json({ ok: true }));
  api.post("/approvals/:id/reject", (req, res) => res.json({ ok: true }));
  api.post("/approvals/:id/request-revision", (req, res) => res.json({ ok: true }));
  api.post("/approvals/:id/comments", (req, res) => res.json({ ok: true }));
  api.post("/companies/:companyId/approvals", (req, res) => res.json({ ok: true }));
  api.post("/approvals/:id/resubmit", (req, res) => res.json({ ok: true }));
  api.patch("/companies/:companyId", (req, res) => res.json({ ok: true }));
  api.post("/companies/:companyId/agents", (req, res) => res.json({ ok: true }));
  api.patch("/issues/:id", (req, res) => res.json({ ok: true }));
  api.get("/companies/:companyId", (req, res) => res.json({ ok: true }));
  app.use("/api", api);

  app.get("/actor", (req, res) => res.json(req.actor));
  app.use(errorHandler);
  return app;
}

function approvalOnlyKeyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: KEY_ID,
    userId: USER_ID,
    name: "Paired iPhone",
    keyHash: hashToken(TOKEN),
    scope: "approval_only",
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("approval_only board key scope guard (actorMiddleware)", () => {
  const ALLOWED = [
    { method: "get", path: `/api/companies/company-1/approvals` },
    { method: "get", path: `/api/approvals/approval-1` },
    { method: "get", path: `/api/approvals/approval-1/issues` },
    { method: "get", path: `/api/approvals/approval-1/comments` },
    { method: "post", path: `/api/approvals/approval-1/approve` },
    { method: "post", path: `/api/approvals/approval-1/reject` },
    { method: "post", path: `/api/approvals/approval-1/request-revision` },
    { method: "post", path: `/api/approvals/approval-1/comments` },
  ] as const;

  const BLOCKED = [
    { method: "post", path: `/api/companies/company-1/approvals`, label: "create approval" },
    { method: "post", path: `/api/approvals/approval-1/resubmit`, label: "resubmit approval" },
    { method: "patch", path: `/api/companies/company-1`, label: "company settings write" },
    { method: "post", path: `/api/companies/company-1/agents`, label: "agent management" },
    { method: "patch", path: `/api/issues/issue-1`, label: "general issue write" },
    { method: "get", path: `/api/companies/company-1`, label: "company read (not on the allowlist)" },
  ] as const;

  for (const { method, path } of ALLOWED) {
    it(`allows ${method.toUpperCase()} ${path} for an approval_only key`, async () => {
      const app = createApp(createDb(approvalOnlyKeyRow()));
      const res = await (request(app) as any)[method](path).set("Authorization", `Bearer ${TOKEN}`).send({});
      expect(res.status, res.text).toBe(200);
      expect(res.body).toMatchObject({ ok: true });
    });
  }

  for (const { method, path, label } of BLOCKED) {
    it(`blocks ${method.toUpperCase()} ${path} (${label}) for an approval_only key with 403`, async () => {
      const app = createApp(createDb(approvalOnlyKeyRow()));
      const res = await (request(app) as any)[method](path).set("Authorization", `Bearer ${TOKEN}`).send({});
      expect(res.status, res.text).toBe(403);
      expect(res.body).toMatchObject({ reason: "board_key_scope_approval_only" });
    });
  }

  it("does not leak the bearer token or its hash in the 403 response body", async () => {
    const app = createApp(createDb(approvalOnlyKeyRow()));
    const res = await request(app)
      .post("/api/companies/company-1/approvals")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({});
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(hashToken(TOKEN));
  });

  it("does not restrict an unscoped (existing CLI/browser) board key on the same paths", async () => {
    const app = createApp(createDb(approvalOnlyKeyRow({ scope: null })));
    const res = await request(app)
      .patch("/api/companies/company-1")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({});
    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("still rejects a revoked approval_only key (existing findBoardApiKeyByToken filtering, unaffected by the scope guard)", async () => {
    // findBoardApiKeyByToken's SQL WHERE filters out revoked keys before this
    // point; simulate that by returning no row, exactly as the real query would.
    // With no matching key, actorMiddleware rejects invalid bearer credentials with 401 fail-closed.
    const app = createApp(createDb(null));
    const res = await request(app).get("/actor").set("Authorization", `Bearer ${TOKEN}`).send();
    expect(res.status, res.text).toBe(401);
    expect(res.body).toEqual({ error: "Agent token did not verify; obtain fresh credentials and retry" });
  });

  it("still rejects an expired approval_only key (existing findBoardApiKeyByToken filtering, unaffected by the scope guard)", async () => {
    const app = createApp(createDb(approvalOnlyKeyRow({ expiresAt: new Date(Date.now() - 60_000) })));
    const res = await request(app).get("/actor").set("Authorization", `Bearer ${TOKEN}`).send();
    expect(res.status, res.text).toBe(401);
    expect(res.body).toEqual({ error: "Agent token did not verify; obtain fresh credentials and retry" });
  });

  it("propagates boardKeyScope onto req.actor for an allowed request", async () => {
    const app = createApp(createDb(approvalOnlyKeyRow()));
    const res = await request(app)
      .get("/api/approvals/approval-1")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send();
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      actor: { type: "board", source: "board_key", boardKeyScope: "approval_only" },
    });
  });

  it("blocks a non-approval route (/actor, outside the /api allowlist entirely) with 403 for an approval_only key", async () => {
    const app = createApp(createDb(approvalOnlyKeyRow()));
    const res = await request(app).get("/actor").set("Authorization", `Bearer ${TOKEN}`).send();
    expect(res.status, res.text).toBe(403);
    expect(res.body).toMatchObject({ reason: "board_key_scope_approval_only" });
  });
});
