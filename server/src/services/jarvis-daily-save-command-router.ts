import type { Db } from "@paperclipai/db";
import { isDailyGithubSaveCommand } from "./jarvis-text-to-plan.js";
import {
  generateDailyGitSaveReportAndApproval,
  type GenerateDailySaveReportOutput,
} from "./jarvis-daily-save-report.js";

export interface HandleJarvisCommandTextInput {
  db: Db;
  companyId: string;
  jarvisAgentId: string;
  repoRoot: string;
  requestText: string;
}

export type HandleJarvisCommandTextResult =
  | { matched: true; report: GenerateDailySaveReportOutput }
  | { matched: false };

export async function handleJarvisCommandText(
  input: HandleJarvisCommandTextInput,
): Promise<HandleJarvisCommandTextResult> {
  if (!isDailyGithubSaveCommand(input.requestText)) {
    return { matched: false };
  }
  const report = await generateDailyGitSaveReportAndApproval({
    db: input.db,
    companyId: input.companyId,
    jarvisAgentId: input.jarvisAgentId,
    repoRoot: input.repoRoot,
    source: "sync02_on_demand_command",
  });
  return { matched: true, report };
}
