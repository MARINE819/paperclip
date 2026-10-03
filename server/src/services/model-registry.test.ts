import { describe, expect, it } from "vitest";
import { DEFAULT_CODEX_LOCAL_MODEL } from "@paperclipai/adapter-codex-local";
import { getDefaultModel, getModelById } from "./model-registry.js";

describe("model-registry — stale default drift regression", () => {
  it("codex_local's default model tracks the adapter package's own DEFAULT_CODEX_LOCAL_MODEL export, not a duplicated literal", () => {
    const defaultModel = getDefaultModel("codex_local");
    expect(defaultModel).not.toBeNull();
    expect(defaultModel?.model).toBe(DEFAULT_CODEX_LOCAL_MODEL);
    // Specifically proves the original incident (codex-t2 pinned to the
    // legacy "gpt-5" slug) cannot silently recur: if the adapter package's
    // own default ever changes, this registry's default changes with it by
    // construction, instead of drifting apart a second time.
    expect(defaultModel?.model).not.toBe("gpt-5");
  });

  it("codex-t2 registry row model equals the adapter's current default", () => {
    const record = getModelById("codex-t2");
    expect(record?.model).toBe(DEFAULT_CODEX_LOCAL_MODEL);
  });
});
