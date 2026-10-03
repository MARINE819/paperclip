import { describe, expect, it } from "vitest";
import {
  getExecutorRegistry,
  getExecutorByType,
  isDynamicRoutingEligibleCategory,
  executorSatisfiesCapability,
  executorSatisfiesCapabilities,
} from "./executor-registry.js";

describe("executor-registry — seeded audit data stays honest", () => {
  it("every executor's provider is a fixed, structural property of the executor itself — never independently overridable at runtime (today's 17 adapters are a 1:1:1 executor/provider/model triple)", () => {
    expect(getExecutorByType("codex_local")?.provider).toBe("openai");
    expect(getExecutorByType("claude_local")?.provider).toBe("anthropic");
    expect(getExecutorByType("gemini_local")?.provider).toBe("google");
    // The registry exposes no setter for `provider` — this is a type-level
    // guarantee (ExecutorRecord.provider is a plain field on a readonly
    // array), not just a seeding convention.
  });

  it("exactly codex_local, claude_local, antigravity_local, hermes_local, and opencode_local are confirmed_working, matching the 2026-10-03 live-verification evidence — gemini_local stays unverified (auth blocked), everything else untouched", () => {
    const confirmedWorking = getExecutorRegistry().filter((e) => e.operationalStatus === "confirmed_working");
    expect(confirmedWorking.map((e) => e.executorType).sort()).toEqual(
      ["antigravity_local", "claude_local", "codex_local", "hermes_local", "opencode_local"].sort(),
    );
    expect(getExecutorByType("gemini_local")?.operationalStatus).toBe("unverified");
  });

  it("paperclip_runner and acpx_local are never eligible regardless of future capability data", () => {
    const paperclipRunner = getExecutorByType("paperclip_runner");
    const acpx = getExecutorByType("acpx_local");
    expect(paperclipRunner?.operationalStatus).toBe("confirmed_broken");
    expect(paperclipRunner?.enabled).toBe(false);
    expect(acpx?.operationalStatus).toBe("retired");
    expect(acpx?.enabled).toBe(false);
  });

  it("browser/gui/localExecution/multiAgent are unknown for every seeded row (zero evidence found for any of them, on any executor)", () => {
    for (const executor of getExecutorRegistry()) {
      expect(executor.capabilities.browser).toBe("unknown");
      expect(executor.capabilities.gui).toBe("unknown");
      expect(executor.capabilities.localExecution).toBe("unknown");
      expect(executor.capabilities.multiAgent).toBe("unknown");
    }
  });

  it("tools/fileEditing/terminal are asserted true only for rows with real evidence (package docs OR 2026-10-03 live/ground-truth-verified probes), unknown everywhere else (no invented capabilities)", () => {
    // Documented-evidence (pre-promotion) rows:
    const expectedTrue = ["codex_local", "claude_local", "gemini_local", "cursor", "grok_local", "kimi_local", "pi_local"];
    for (const type of expectedTrue) {
      const executor = getExecutorByType(type)!;
      expect(executor.capabilities.tools).toBe(true);
      expect(executor.capabilities.fileEditing).toBe(true);
      expect(executor.capabilities.terminal).toBe(true);
    }
    const expectedUnknownEverything = ["cursor_cloud", "hermes_gateway", "openclaw_gateway", "paperclip_runner", "acpx_local", "process", "http"];
    for (const type of expectedUnknownEverything) {
      const executor = getExecutorByType(type)!;
      expect(executor.capabilities.tools).toBe("unknown");
      expect(executor.capabilities.fileEditing).toBe("unknown");
    }
    // hermes_local and opencode_local: ground-truth-verified live probes
    // 2026-10-03 (terminal echo + file read + file write, each confirmed on
    // disk afterward) — all three true.
    for (const type of ["hermes_local", "opencode_local"]) {
      const executor = getExecutorByType(type)!;
      expect(executor.capabilities.tools).toBe(true);
      expect(executor.capabilities.fileEditing).toBe(true);
      expect(executor.capabilities.terminal).toBe(true);
    }
    // antigravity_local: file_read/file_editing ground-truth-verified, but
    // terminal/RunCommand is unconditionally auto-denied in its own headless
    // mode (an environment constraint, not evidence either way) — stays
    // unknown rather than guessed.
    const antigravityLocal = getExecutorByType("antigravity_local")!;
    expect(antigravityLocal.capabilities.tools).toBe(true);
    expect(antigravityLocal.capabilities.fileEditing).toBe(true);
    expect(antigravityLocal.capabilities.terminal).toBe("unknown");
  });

  it("TOOL_EXECUTION_ONLY and GATEWAY_META_PROVIDER categories are never dynamic-routing eligible", () => {
    expect(isDynamicRoutingEligibleCategory("TOOL_EXECUTION_ONLY")).toBe(false);
    expect(isDynamicRoutingEligibleCategory("GATEWAY_META_PROVIDER")).toBe(false);
    expect(isDynamicRoutingEligibleCategory("CODING_AGENT_RUNTIME")).toBe(true);
  });

  it("an unknown capability flag never satisfies a stated requirement (fail-closed)", () => {
    const claudeLocal = getExecutorByType("claude_local")!;
    expect(claudeLocal.capabilities.browser).toBe("unknown");
    expect(executorSatisfiesCapability(claudeLocal, "browser")).toBe(false);
  });

  it("long_context is only satisfied by a verified maxContextTokens value, never assumed", () => {
    const codexLocal = getExecutorByType("codex_local")!;
    expect(codexLocal.maxContextTokens).toBeNull();
    expect(executorSatisfiesCapability(codexLocal, "long_context")).toBe(false);
  });

  it("hermes_local/antigravity_local/opencode_local now support models via runtime_discovery (NOT a fixed static_registry row) — supportsModels=true is honest now that a live discovery bridge exists, not an invented static entry", () => {
    for (const type of ["hermes_local", "antigravity_local", "opencode_local"]) {
      const executor = getExecutorByType(type)!;
      expect(executor.operationalStatus).toBe("confirmed_working");
      expect(executor.supportsModels).toBe(true);
      expect(executor.modelSourceType).toBe("runtime_discovery");
    }
    // static_registry executors are unaffected.
    expect(getExecutorByType("codex_local")?.modelSourceType).toBe("static_registry");
  });

  it("antigravity_local's browser/gui/local_execution capabilities stay fully unknown even after promotion — operational verification proved end-to-end execution and file I/O, not those specific capabilities, so none was inflated", () => {
    const antigravityLocal = getExecutorByType("antigravity_local")!;
    expect(antigravityLocal.operationalStatus).toBe("confirmed_working");
    expect(antigravityLocal.capabilities.browser).toBe("unknown");
    expect(antigravityLocal.capabilities.gui).toBe("unknown");
    expect(antigravityLocal.capabilities.localExecution).toBe("unknown");
  });

  it("structured_output and multimodal fail closed for every executor today (no registry flag exists for them yet)", () => {
    for (const executor of getExecutorRegistry()) {
      expect(executorSatisfiesCapability(executor, "structured_output")).toBe(false);
      expect(executorSatisfiesCapability(executor, "multimodal")).toBe(false);
    }
  });

  it("executorSatisfiesCapabilities requires every listed requirement, not just one", () => {
    const codexLocal = getExecutorByType("codex_local")!;
    expect(executorSatisfiesCapabilities(codexLocal, [])).toBe(true);
    // tool_calling is verified true for codex_local, but browser is not — the
    // combined requirement must fail since not every item is satisfied.
    expect(executorSatisfiesCapabilities(codexLocal, ["tool_calling"])).toBe(true);
    expect(executorSatisfiesCapabilities(codexLocal, ["browser"])).toBe(false);
    expect(executorSatisfiesCapabilities(codexLocal, ["tool_calling", "browser"])).toBe(false);
  });
});
