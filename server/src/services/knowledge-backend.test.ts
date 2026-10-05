import { describe, expect, it } from "vitest";
import {
  createObsidianKnowledgeBackend,
  getActiveKnowledgeBackendId,
  getKnowledgeBackend,
  UnknownKnowledgeBackendError,
} from "./knowledge-backend.js";

// F-08 Pluggable Knowledge Backend — pure unit coverage for the interface,
// registry, and the Obsidian adapter's translation logic. Filesystem/vault
// behavior itself stays covered by the existing obsidian-sync test suites,
// re-run unchanged as regression evidence for this batch.

describe("F-08 knowledge backend registry", () => {
  it("[registration] getKnowledgeBackend('obsidian') resolves to a backend with id='obsidian'", () => {
    const backend = getKnowledgeBackend("obsidian");
    expect(backend.id).toBe("obsidian");
  });

  it("[capabilities] obsidian backend declares write=true, read=false", () => {
    const backend = getKnowledgeBackend("obsidian");
    expect(backend.capabilities).toEqual({ write: true, read: false });
  });

  it("[fail-closed] an unknown backend id throws UnknownKnowledgeBackendError rather than falling back to Obsidian", () => {
    expect(() => getKnowledgeBackend("notion")).toThrow(UnknownKnowledgeBackendError);
    expect(() => getKnowledgeBackend("")).toThrow(UnknownKnowledgeBackendError);
  });

  it("[active backend default] getActiveKnowledgeBackendId defaults to 'obsidian' when the env var is unset", () => {
    expect(getActiveKnowledgeBackendId({})).toBe("obsidian");
  });

  it("[active backend override] getActiveKnowledgeBackendId honors PAPERCLIP_KNOWLEDGE_BACKEND when set", () => {
    expect(getActiveKnowledgeBackendId({ PAPERCLIP_KNOWLEDGE_BACKEND: "obsidian" })).toBe("obsidian");
  });
});

describe("F-08 Obsidian adapter — write result contract", () => {
  const record = { id: "rec-1", companyId: "co-1", title: "Title", summary: null, body: "Body" };

  it("[synced] maps the legacy {state:'synced', relativePath} outcome onto the generic {state:'synced', externalRef} shape", async () => {
    const backend = createObsidianKnowledgeBackend({
      obsidianSyncFn: async () => ({ state: "synced", relativePath: "knowledge/title-rec-1.md" }),
    });
    const result = await backend.writeRecord({ ...record, externalRef: null });
    expect(result).toEqual({ state: "synced", externalRef: "knowledge/title-rec-1.md" });
  });

  it("[failed] maps the legacy {state:'failed', error} outcome onto the generic shape unchanged", async () => {
    const backend = createObsidianKnowledgeBackend({
      obsidianSyncFn: async () => ({ state: "failed", error: "injected failure" }),
    });
    const result = await backend.writeRecord({ ...record, externalRef: null });
    expect(result).toEqual({ state: "failed", error: "injected failure" });
  });

  it("[externalRef round-trip] a prior externalRef is passed through to the legacy sync fn as obsidianPath, preserving idempotent re-sync to the same path", async () => {
    let receivedObsidianPath: string | null | undefined;
    const backend = createObsidianKnowledgeBackend({
      obsidianSyncFn: async (_vault, rec) => {
        receivedObsidianPath = rec.obsidianPath;
        return { state: "synced", relativePath: rec.obsidianPath ?? "knowledge/new.md" };
      },
    });
    await backend.writeRecord({ ...record, externalRef: "knowledge/existing-path.md" });
    expect(receivedObsidianPath).toBe("knowledge/existing-path.md");
  });

  it("[vault root threading] obsidianVaultRoot override is passed through to the legacy sync fn", async () => {
    let receivedVaultRoot: string | null | undefined;
    const backend = createObsidianKnowledgeBackend({
      obsidianVaultRoot: "/fake/vault",
      obsidianSyncFn: async (vault) => {
        receivedVaultRoot = vault;
        return { state: "synced", relativePath: "knowledge/x.md" };
      },
    });
    await backend.writeRecord({ ...record, externalRef: null });
    expect(receivedVaultRoot).toBe("/fake/vault");
  });
});
