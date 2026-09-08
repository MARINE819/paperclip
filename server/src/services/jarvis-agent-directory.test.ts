import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { getAgentByIdForDelegation, listCompanyAgentsForDelegation } from "./jarvis-agent-directory.js";

const ROW = {
  id: "agent-1",
  companyId: "company-1",
  name: "Agent One",
  status: "idle",
  reportsTo: null,
  adapterType: "codex_local",
  capabilities: "typescript, testing",
};

function chainableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows) as Promise<unknown[]> & { limit?: (n: number) => Promise<unknown[]> };
  promise.limit = (n: number) => Promise.resolve(rows.slice(0, n));
  return promise;
}

function createFakeDb(rows: unknown[]): Db {
  const where = vi.fn(() => chainableRows(rows));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select } as unknown as Db;
}

describe("listCompanyAgentsForDelegation", () => {
  it("maps rows into JarvisSelectableAgent shape", async () => {
    const db = createFakeDb([ROW]);
    const result = await listCompanyAgentsForDelegation(db, "company-1");
    expect(result).toEqual([
      {
        id: "agent-1",
        companyId: "company-1",
        name: "Agent One",
        status: "idle",
        reportsTo: null,
        adapterType: "codex_local",
        capabilities: "typescript, testing",
      },
    ]);
  });

  it("returns an empty array when the company has no agents", async () => {
    const db = createFakeDb([]);
    const result = await listCompanyAgentsForDelegation(db, "company-empty");
    expect(result).toEqual([]);
  });
});

describe("getAgentByIdForDelegation", () => {
  it("returns the mapped agent when found", async () => {
    const db = createFakeDb([ROW]);
    const result = await getAgentByIdForDelegation(db, "agent-1");
    expect(result?.id).toBe("agent-1");
    expect(result?.capabilities).toBe("typescript, testing");
  });

  it("returns null when no agent matches", async () => {
    const db = createFakeDb([]);
    const result = await getAgentByIdForDelegation(db, "missing-agent");
    expect(result).toBeNull();
  });
});
