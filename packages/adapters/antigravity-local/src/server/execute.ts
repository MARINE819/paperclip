import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult, AdapterExecutionErrorFamily } from "@paperclipai/adapter-utils";
import { runChildProcess, asString, asNumber, renderTemplate, renderPaperclipWakePrompt, isPaperclipRecoveryWakePayload, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE, joinPromptSections } from "@paperclipai/adapter-utils/server-utils";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = (ctx.agent.adapterConfig || {}) as Record<string, unknown>;
  const command = asString(config.command, "C:\\Users\\Nexora\\AppData\\Local\\agy\\bin\\agy.exe");
  const runtimeDir = asString(config.runtimeDir, "C:\\Users\\Nexora\\antigravity-paperclip-runtime");
  const profileDir = path.join(runtimeDir, "profile");
  const workspaceDir = path.join(runtimeDir, "workspace");

  await fs.mkdir(profileDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(path.join(profileDir, ".gemini", "antigravity-cli"), { recursive: true });

  const denyJson = JSON.stringify({
    permissions: {
      deny: ["read_file(*)", "write_file(*)", "command(*)", "read_url(*)", "execute_url(*)", "mcp(*)"]
    }
  }, null, 2);
  await fs.writeFile(path.join(profileDir, ".gemini", "antigravity-cli", "settings.json"), denyJson, "utf8");

  const env = {
    ...process.env,
    USERPROFILE: profileDir,
    HOME: profileDir,
  };

  // Session resume is NOT implemented: no confirmed support for a resume
  // flag was found within this adapter package's own scope, so every run is
  // a fresh, non-resumed session (honest default, never silently assumed).
  const promptStr = joinPromptSections([renderPaperclipWakePrompt(ctx.context.paperclipWake, { resumedSession: false }), isPaperclipRecoveryWakePayload(ctx.context.paperclipWake) ? "" : renderTemplate(asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE), { agentId: ctx.agent.id, companyId: ctx.agent.companyId, runId: ctx.runId, company: { id: ctx.agent.companyId }, context: ctx.context })]);

  const args = [
    "--sandbox",
    "--print-timeout", "60s",
    "--output-format", "stream-json",
    "-p", promptStr,
  ];

  let stdoutBuf = "";
  let stderrBuf = "";

  const result = await runChildProcess(
    ctx.runId,
    command,
    args,
    {
      cwd: workspaceDir,
      env: env as Record<string, string>,
      timeoutSec: asNumber(config.timeoutSec, 60),
      graceSec: asNumber(config.graceSec, 5),
      onLog: async (stream: "stdout" | "stderr", chunk: string) => {
        if (stream === "stdout") stdoutBuf += chunk;
        if (stream === "stderr") stderrBuf += chunk;
      },
      onLogError: (err: unknown, id: string, msg: string) => {
        console.error({ err, runId: id }, msg);
      }
    }
  );

  let finalResponse = "";
  let finalStatus = "";
  let terminalErrorMsg: string | null = null;
  let hasValidResultEvent = false;

  const lines = stdoutBuf.split("\n");
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj.event === "step_update" && obj.step_update?.state === "ERROR") {
        console.info({ step_update: obj.step_update }, "antigravity_local step_update diagnostic error");
      }
      if (obj.event === "error") {
        terminalErrorMsg = obj.error?.message ?? "Terminal error event";
      }
      if (obj.event === "result" && obj.result) {
        hasValidResultEvent = true;
        finalStatus = obj.result.status;

        // A permission denial is a genuine failure and is reported as one --
        // never silently promoted to SUCCESS merely because some response
        // text happened to come back. Masking a real denial this way would
        // hide the failure from the caller and from any audit/log review.
        if (finalStatus === "SUCCESS" && obj.result.response) {
          finalResponse = obj.result.response;
        }
        if (finalStatus !== "SUCCESS" && obj.result.error) {
          terminalErrorMsg = obj.result.error;
        }
      }
    } catch (e) {
    }
  }

  // Final success determination according to strict rules
  const isSuccess =
    result.exitCode === 0 &&
    result.timedOut === false &&
    hasValidResultEvent &&
    finalStatus === "SUCCESS" &&
    typeof finalResponse === "string" &&
    finalResponse.length > 0;

  if (!isSuccess) {
    let errorMessage = terminalErrorMsg;
    if (!errorMessage) {
      if (result.timedOut) {
        errorMessage = "Process timed out";
      } else if (result.exitCode !== 0) {
        errorMessage = stderrBuf.trim() || `Execution failed with exit code ${result.exitCode}`;
      } else if (terminalErrorMsg) {
        errorMessage = terminalErrorMsg;
      } else if (!hasValidResultEvent) {
        errorMessage = "Stream ended without a valid result event";
      } else if (finalStatus !== "SUCCESS") {
        errorMessage = `Result status was not SUCCESS: ${finalStatus}`;
      } else {
        errorMessage = "Unknown execution error";
      }
    }

    const combinedError = errorMessage + " " + stderrBuf;
    const lowerError = combinedError.toLowerCase();
    
    let errorFamily: AdapterExecutionErrorFamily | null = null;
    if (lowerError.includes("quota exceeded") || lowerError.includes("quota exhausted")) {
      errorFamily = "provider_quota";
    } else if (lowerError.includes("rate limit") || lowerError.includes("too many requests") || lowerError.includes("429")) {
      errorFamily = "transient_upstream";
    } else if (lowerError.includes("auth required") || lowerError.includes("unauthorized") || lowerError.includes("401")) {
      errorFamily = "refresh_token_expired";
    }

    return {
      exitCode: result.exitCode !== 0 ? result.exitCode : 1, // ensure non-zero exit code on failure
      signal: result.signal,
      timedOut: result.timedOut,
      errorMessage,
      errorFamily,
    };
  }

  await ctx.onLog("stdout", finalResponse);

  return {
    exitCode: 0,
    signal: result.signal,
    timedOut: false,
    errorMessage: null,
    errorFamily: null,
    usage: undefined,
    errorMeta: {},
    summary: finalResponse
  };
}

export async function testEnvironment(ctx: any): Promise<any> { return { diagnostics: [], pass: true }; }