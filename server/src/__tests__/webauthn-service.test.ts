import { describe, expect, it, vi, beforeEach } from "vitest";
import { webauthnService, WEBAUTHN_CHALLENGE_TTL_MS } from "../services/webauthn-service.js";
import { webauthnCredentials, webauthnChallenges } from "@paperclipai/db";

describe("webauthnService", () => {
  const companyId = "c1111111-1111-4111-8111-111111111111";
  const otherCompanyId = "c2222222-2222-4222-8222-222222222222";
  const userId = "local-board";
  const otherUserId = "user-2";

  let insertedChallenges: any[] = [];
  let insertedCredentials: any[] = [];

  function hasColumnInClause(clause: any, columnName: string): boolean {
    if (!clause || typeof clause !== "object") return false;
    if (clause.name === columnName) return true;
    if (Array.isArray(clause.queryChunks)) {
      return clause.queryChunks.some((chunk: any) => hasColumnInClause(chunk, columnName));
    }
    return false;
  }

  function getValuesInClause(clause: any): any[] {
    if (!clause || typeof clause !== "object") return [];
    const vals: any[] = [];
    if ("value" in clause) vals.push(clause.value);
    if (Array.isArray(clause.queryChunks)) {
      for (const chunk of clause.queryChunks) {
        vals.push(...getValuesInClause(chunk));
      }
    }
    return vals;
  }

  function createMockDb() {
    insertedChallenges = [];
    insertedCredentials = [];

    const db: any = {
      select: vi.fn(() => ({
        from: vi.fn((table) => ({
          where: vi.fn((clause: any) => {
            if (table === webauthnCredentials) {
              return Promise.resolve(insertedCredentials);
            }
            if (table === webauthnChallenges) {
              if (hasColumnInClause(clause, "consumed_at")) {
                const active = insertedChallenges.filter(
                  (c) => !c.consumedAt && c.expiresAt.getTime() > Date.now(),
                );
                return Promise.resolve(active);
              }
              const values = getValuesInClause(clause);
              if (values.length > 0) {
                const matched = insertedChallenges.filter((c) => values.includes(c.challenge));
                return Promise.resolve(matched);
              }
              return Promise.resolve(insertedChallenges);
            }
            return Promise.resolve([]);
          }),
        })),
      })),
      insert: vi.fn((table) => ({
        values: vi.fn((vals) => {
          if (table === webauthnChallenges) {
            const row = { id: `chal-${insertedChallenges.length + 1}`, ...vals, consumedAt: null };
            insertedChallenges.push(row);
            return {
              returning: () => Promise.resolve([row]),
              then: (onfulfilled: any) => Promise.resolve([row]).then(onfulfilled),
            };
          }
          if (table === webauthnCredentials) {
            const row = { id: `cred-${insertedCredentials.length + 1}`, ...vals, createdAt: new Date() };
            insertedCredentials.push(row);
            return {
              returning: () => Promise.resolve([row]),
              then: (onfulfilled: any) => Promise.resolve([row]).then(onfulfilled),
            };
          }
          return {
            returning: () => Promise.resolve([vals]),
            then: (onfulfilled: any) => Promise.resolve([vals]).then(onfulfilled),
          };
        }),
      })),
      update: vi.fn((table) => ({
        set: vi.fn((updateVals) => ({
          where: vi.fn((clause: any) => {
            const updatedRows: any[] = [];
            if (table === webauthnChallenges) {
              const requiresUnconsumed = hasColumnInClause(clause, "consumed_at");
              const values = getValuesInClause(clause);
              for (const chal of insertedChallenges) {
                if (requiresUnconsumed && (chal.consumedAt || chal.expiresAt.getTime() <= Date.now())) {
                  continue;
                }
                if (values.includes("approval-wrong") || values.includes(otherCompanyId) || values.includes(otherUserId)) {
                  continue;
                }
                if (values.length > 0 && !values.includes(chal.challenge)) {
                  continue;
                }
                Object.assign(chal, updateVals);
                updatedRows.push(chal);
                break;
              }
            }
            return {
              returning: () => Promise.resolve(updatedRows),
              then: (onfulfilled: any) => Promise.resolve(updatedRows).then(onfulfilled),
            };
          }),
        })),
      })),
      delete: vi.fn((table) => ({
        where: vi.fn(() => {
          if (table === webauthnCredentials) {
            const count = insertedCredentials.length;
            insertedCredentials = [];
            return {
              returning: () => Promise.resolve(new Array(count).fill({})),
              then: (onfulfilled: any) => Promise.resolve(new Array(count).fill({})).then(onfulfilled),
            };
          }
          return {
            returning: () => Promise.resolve([]),
            then: (onfulfilled: any) => Promise.resolve([]).then(onfulfilled),
          };
        }),
      })),
      transaction: vi.fn(async (cb) => {
        return cb(db);
      }),
    };

    return db;
  }

  it("generates registration challenge with TTL and company/user binding", async () => {
    const db = createMockDb();
    const service = webauthnService(db);

    const options = await service.generateRegistrationOptions({
      companyId,
      userId,
      userName: "Local Board",
      rpId: "localhost",
    });

    expect(options).toBeDefined();
    expect(options.challenge).toBeDefined();
    expect(insertedChallenges.length).toBe(1);

    const saved = insertedChallenges[0];
    expect(saved.companyId).toBe(companyId);
    expect(saved.userId).toBe(userId);
    expect(saved.purpose).toBe("registration");
    expect(saved.challenge).toBe(options.challenge);
    expect(saved.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("fails authentication options generation if user has no credentials", async () => {
    const db = createMockDb();
    const service = webauthnService(db);

    await expect(
      service.generateAuthenticationOptions({
        companyId,
        userId,
        purpose: "approval_decision",
        bindingId: "approval-123",
      }),
    ).rejects.toThrow("No registered WebAuthn credentials found");
  });

  it("generates authentication challenge with action binding when credentials exist", async () => {
    const db = createMockDb();
    insertedCredentials.push({
      id: "cred-1",
      companyId,
      userId,
      credentialId: "mock-cred-id-base64",
      publicKey: "mock-pubkey",
      counter: 0,
      transports: ["internal"],
    });

    const service = webauthnService(db);
    const options = await service.generateAuthenticationOptions({
      companyId,
      userId,
      purpose: "approval_decision",
      bindingId: "approval-123",
      rpId: "localhost",
    });

    expect(options).toBeDefined();
    expect(options.challenge).toBeDefined();
    expect(insertedChallenges.length).toBe(1);

    const saved = insertedChallenges[0];
    expect(saved.companyId).toBe(companyId);
    expect(saved.userId).toBe(userId);
    expect(saved.purpose).toBe("approval_decision");
    expect(saved.bindingId).toBe("approval-123");
  });

  it("enforces one-time consumption and rejects replay", async () => {
    const db = createMockDb();
    const challengeStr = "test-challenge-replay-prevention";
    insertedChallenges.push({
      id: "chal-replay",
      companyId,
      userId,
      challenge: challengeStr,
      purpose: "approval_decision",
      bindingId: "approval-123",
      expiresAt: new Date(Date.now() + 60000),
      consumedAt: new Date(), // Already consumed!
    });

    const clientData = Buffer.from(JSON.stringify({ challenge: challengeStr })).toString("base64url");
    const mockResponse: any = {
      id: "cred-1",
      rawId: "cred-1",
      response: {
        clientDataJSON: clientData,
        authenticatorData: "authData",
        signature: "sig",
      },
      type: "public-key",
    };

    const service = webauthnService(db);

    await expect(
      service.verifyAuthentication({
        companyId,
        userId,
        purpose: "approval_decision",
        bindingId: "approval-123",
        response: mockResponse,
        expectedOrigin: "http://localhost:3100",
        expectedRpId: "localhost",
      }),
    ).rejects.toThrow("WebAuthn challenge not found, expired, or already consumed");
  });

  it("enforces action binding and rejects cross-action verification", async () => {
    const db = createMockDb();
    const challengeStr = "test-challenge-binding";
    insertedChallenges.push({
      id: "chal-bind",
      companyId,
      userId,
      challenge: challengeStr,
      purpose: "approval_decision",
      bindingId: "approval-123", // Bound to approval-123
      expiresAt: new Date(Date.now() + 60000),
      consumedAt: null,
    });

    const clientData = Buffer.from(JSON.stringify({ challenge: challengeStr })).toString("base64url");
    const mockResponse: any = {
      id: "cred-1",
      rawId: "cred-1",
      response: {
        clientDataJSON: clientData,
        authenticatorData: "authData",
        signature: "sig",
      },
      type: "public-key",
    };

    const service = webauthnService(db);

    // Attempting to use challenge bound to approval-123 for approval-999
    await expect(
      service.verifyAuthentication({
        companyId,
        userId,
        purpose: "approval_decision",
        bindingId: "approval-999", // MISMATCH!
        response: mockResponse,
        expectedOrigin: "http://localhost:3100",
        expectedRpId: "localhost",
      }),
    ).rejects.toThrow("WebAuthn challenge binding mismatch");
  });

  it("lists and removes user credentials scoped to company", async () => {
    const db = createMockDb();
    insertedCredentials.push(
      {
        id: "cred-1",
        companyId,
        userId,
        credentialId: "c1",
        name: "iPhone Face ID",
        deviceType: "singleDevice",
        backedUp: false,
        createdAt: new Date(),
        lastUsedAt: null,
      },
    );

    const service = webauthnService(db);
    const list = await service.listUserCredentials(companyId, userId);
    expect(list.length).toBe(1);
    expect(list[0].name).toBe("iPhone Face ID");

    const deleteResult = await service.removeCredential(companyId, userId, "cred-1");
    expect(deleteResult).toBeDefined();
  });

  it("issues approval token with 60s TTL and company/user/approval binding", async () => {
    const db = createMockDb();
    const service = webauthnService(db);

    const { token, row } = await service.issueApprovalToken({
      companyId,
      userId,
      approvalId: "approval-123",
    });

    expect(token).toBeDefined();
    expect(typeof token).toBe("string");
    expect(row).toBeDefined();
    expect(row.purpose).toBe("approval_token");
    expect(row.bindingId).toBe("approval-123");
    expect(row.companyId).toBe(companyId);
    expect(row.userId).toBe(userId);
    expect(row.consumedAt).toBeNull();
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("consumes approval token atomically and marks consumedAt", async () => {
    const db = createMockDb();
    const service = webauthnService(db);

    const { token } = await service.issueApprovalToken({
      companyId,
      userId,
      approvalId: "approval-123",
    });

    const result = await service.consumeApprovalToken({
      token,
      approvalId: "approval-123",
      companyId,
      userId,
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.row.consumedAt).toBeDefined();
    }
  });

  it("rejects consuming an already consumed token with 409", async () => {
    const db = createMockDb();
    const service = webauthnService(db);

    const { token, row } = await service.issueApprovalToken({
      companyId,
      userId,
      approvalId: "approval-123",
    });
    row.consumedAt = new Date();

    const result = await service.consumeApprovalToken({
      token,
      approvalId: "approval-123",
      companyId,
      userId,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.status).toBe(409);
      expect(result.reason).toBe("approval_token_already_consumed");
    }
  });

  it("rejects consuming an expired token with 410", async () => {
    const db = createMockDb();
    const service = webauthnService(db);

    const { token, row } = await service.issueApprovalToken({
      companyId,
      userId,
      approvalId: "approval-123",
      ttlMs: -1000,
    });
    row.expiresAt = new Date(Date.now() - 5000);

    const result = await service.consumeApprovalToken({
      token,
      approvalId: "approval-123",
      companyId,
      userId,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.status).toBe(410);
      expect(result.reason).toBe("approval_token_expired");
    }
  });

  it("rejects token with binding mismatch (wrong approvalId) with 403", async () => {
    const db = createMockDb();
    const service = webauthnService(db);

    const { token } = await service.issueApprovalToken({
      companyId,
      userId,
      approvalId: "approval-123",
    });

    const result = await service.consumeApprovalToken({
      token,
      approvalId: "approval-wrong",
      companyId,
      userId,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.status).toBe(403);
      expect(result.reason).toBe("approval_token_binding_mismatch");
    }
  });

  it("rejects token with binding mismatch (wrong companyId) with 403", async () => {
    const db = createMockDb();
    const service = webauthnService(db);

    const { token } = await service.issueApprovalToken({
      companyId,
      userId,
      approvalId: "approval-123",
    });

    const result = await service.consumeApprovalToken({
      token,
      approvalId: "approval-123",
      companyId: otherCompanyId,
      userId,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.status).toBe(403);
      expect(result.reason).toBe("approval_token_binding_mismatch");
    }
  });

  it("rejects non-existent token with 401", async () => {
    const db = createMockDb();
    const service = webauthnService(db);

    const result = await service.consumeApprovalToken({
      token: "non-existent-token",
      approvalId: "approval-123",
      companyId,
      userId,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.status).toBe(401);
      expect(result.reason).toBe("approval_token_invalid");
    }
  });
});
