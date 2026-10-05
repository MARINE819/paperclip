import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentApiKeys, agents, authUsers, boardApiKeys, companyMemberships, heartbeatRuns, instanceUserRoles } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";

const BOARD_TOKEN = "pcp_board_test-token";
const BOARD_USER_ID = "33333333-3333-4333-8333-333333333333";

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

function createDbState(input: {
  agent?: { id: string; companyId: string; status?: string };
  boardKey?: boolean;
} = {}) {
  const selectCalls: unknown[] = [];
  const agentRow = input.agent
    ? { id: input.agent.id, companyId: input.agent.companyId, status: input.agent.status ?? "active" }
    : null;
  const boardKeyRow = input.boardKey
    ? { id: randomUUID(), userId: BOARD_USER_ID, keyHash: hashToken(BOARD_TOKEN), scope: null, revokedAt: null, expiresAt: null }
    : null;

  const db = {
    select: () =>
      createSelectChain((table) => {
        selectCalls.push(table);
        if (table === boardApiKeys) return boardKeyRow ? [boardKeyRow] : [];
        if (table === authUsers) return boardKeyRow ? [{ id: BOARD_USER_ID, name: "Board User", email: "board@example.com" }] : [];
        if (table === companyMemberships) return [];
        if (table === instanceUserRoles) return [];
        if (table === agentApiKeys) return [];
        if (table === agents) return agentRow ? [agentRow] : [];
        if (table === heartbeatRuns) return [];
        return [];
      }),
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
    insert: () => ({ values: () => Promise.resolve([]) }),
  } as any;

  return { db, selectCalls };
}

function createApp(db: any, deploymentMode: "authenticated" | "local_trusted" = "authenticated") {
  const app = express();
  app.use(express.json());
  app.use(
    actorMiddleware(db, {
      deploymentMode,
      resolveSession: async () => null,
    }),
  );
  app.post("/api/tool-gateway/gateways/:gatewayId/mcp", (req, res) => {
    res.json({ reachedGatewayRoute: true, actorType: req.actor?.type ?? null });
  });
  app.post("/mcp/gateways/:gatewayPublicId", (req, res) => {
    res.json({ reachedGatewayRoute: true, actorType: req.actor?.type ?? null });
  });
  app.get("/api/tool-gateway/gateways/:gatewayId/mcp", (req, res) => {
    res.json({ reachedGatewayRoute: true, actorType: req.actor?.type ?? null });
  });
  app.post("/api/issues/:id/comments", (req, res) => {
    res.json({ reachedUnrelatedRoute: true, actorType: req.actor?.type ?? null });
  });
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  app.use(errorHandler);
  return app;
}

describe("actorMiddleware — named MCP gateway pcgw_ bypass", () => {
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const originalTtl = process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
  const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "gateway-bypass-test-secret";
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "3600";
    delete process.env.PAPERCLIP_INSTANCE_ID;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
    if (originalTtl === undefined) delete process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
    else process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = originalTtl;
    if (originalInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;
  });

  it("lets a pcgw_-shaped bearer token reach the named gateway route without querying board/agent auth tables", async () => {
    const { db, selectCalls } = createDbState();
    const gatewayId = randomUUID();

    const res = await request(createApp(db))
      .post(`/api/tool-gateway/gateways/${gatewayId}/mcp`)
      .set("Authorization", "Bearer pcgw_deadbeef-0000-4000-8000-0000deadbeef.fake-token-body")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reachedGatewayRoute: true });
    // Bypass must short-circuit before any board/agentApiKey/agent lookup.
    expect(selectCalls.length).toBe(0);
  });

  it("bypasses the sibling public gateway path with a pcgw_ token", async () => {
    const { db, selectCalls } = createDbState();
    const gatewayPublicId = randomUUID();

    const res = await request(createApp(db))
      .post(`/mcp/gateways/${gatewayPublicId}`)
      .set("Authorization", "Bearer pcgw_deadbeef-0000-4000-8000-0000deadbeef.fake-token-body")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reachedGatewayRoute: true });
    expect(selectCalls.length).toBe(0);
  });

  it("does NOT bypass a pcgw_-shaped token on an unrelated route", async () => {
    const { db, selectCalls } = createDbState();

    const res = await request(createApp(db, "local_trusted"))
      .post(`/api/issues/${randomUUID()}/comments`)
      .set("Authorization", "Bearer pcgw_deadbeef-0000-4000-8000-0000deadbeef.fake-token-body")
      .send({ body: "hi" });

    // Falls through to the normal chain, which rejects the unrecognized token.
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Agent token did not verify");
    expect(selectCalls.length).toBeGreaterThan(0);
  });

  it("leaves normal board API key authentication on the gateway route unchanged", async () => {
    const { db } = createDbState({ boardKey: true });
    const gatewayId = randomUUID();

    const res = await request(createApp(db))
      .post(`/api/tool-gateway/gateways/${gatewayId}/mcp`)
      .set("Authorization", `Bearer ${BOARD_TOKEN}`)
      .send({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reachedGatewayRoute: true, actorType: "board" });
  });

  it("leaves normal agent JWT authentication on the gateway route unchanged", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({ agent: { id: agentId, companyId } });
    const token = createLocalAgentJwt(agentId, companyId, "claude_local", runId, "user-1");
    const gatewayId = randomUUID();

    const res = await request(createApp(db))
      .post(`/api/tool-gateway/gateways/${gatewayId}/mcp`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reachedGatewayRoute: true, actorType: "agent" });
  });

  it("does not accidentally authenticate a missing Authorization header on the gateway route", async () => {
    const { db } = createDbState();
    const gatewayId = randomUUID();

    const resAuthenticated = await request(createApp(db, "authenticated"))
      .post(`/api/tool-gateway/gateways/${gatewayId}/mcp`)
      .send({ jsonrpc: "2.0", id: 1, method: "initialize" });
    // Unchanged pre-existing behavior: no session resolver configured, so the
    // actor stays "none" and the request passes through with no identity —
    // it is the gateway route's own token check that must reject it, not this middleware.
    expect(resAuthenticated.body.actorType).not.toBe("board");
    expect(resAuthenticated.body.actorType).not.toBe("agent");

    const resLocalTrusted = await request(createApp(db, "local_trusted"))
      .post(`/api/tool-gateway/gateways/${gatewayId}/mcp`)
      .send({ jsonrpc: "2.0", id: 1, method: "initialize" });
    // Pre-existing local_trusted default-board passthrough, unrelated to the pcgw_ bypass.
    expect(resLocalTrusted.body.actorType).toBe("board");
  });
});
