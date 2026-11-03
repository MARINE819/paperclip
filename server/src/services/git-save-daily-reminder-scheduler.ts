import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import {
  createMemoryCandidateReconcilerScheduler as createGitSaveDailyReminderScheduler,
  type MemoryCandidateReconcilerSchedulerLogger as GitSaveDailyReminderSchedulerLogger,
  type MemoryCandidateReconcilerScheduler as GitSaveDailyReminderScheduler,
} from "./memory-candidate-reconciler-scheduler.js";
import { generateDailyGitSaveReportAndApproval } from "./jarvis-daily-save-report.js";

export {
  createGitSaveDailyReminderScheduler,
  type GitSaveDailyReminderScheduler,
  type GitSaveDailyReminderSchedulerLogger,
};

export function isWithinKstReminderHour(now: Date, targetHour = 21): boolean {
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  return kst.getUTCHours() === targetHour;
}

export interface RunGitSaveDailyReminderTickInput {
  db: Db;
  repoRoot: string;
  now?: () => Date;
}

export async function runGitSaveDailyReminderTick(input: RunGitSaveDailyReminderTickInput) {
  const now = input.now ?? (() => new Date());
  if (!isWithinKstReminderHour(now())) {
    return { skipped: true as const, reason: "outside_kst_21_hour" };
  }

  const companyRows = await input.db.select({ id: companies.id }).from(companies);
  const perCompany: Array<{ companyId: string; skipped?: string; approvalId?: string | null; error?: string }> = [];

  for (const company of companyRows) {
    const [jarvisAgent] = await input.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, company.id), eq(agents.name, "JARVIS")));
    if (!jarvisAgent) {
      perCompany.push({ companyId: company.id, skipped: "no_jarvis_agent" });
      continue;
    }
    try {
      const report = await generateDailyGitSaveReportAndApproval({
        db: input.db,
        companyId: company.id,
        jarvisAgentId: jarvisAgent.id,
        repoRoot: input.repoRoot,
        source: "sync02_daily_reminder",
        now,
      });
      perCompany.push({ companyId: company.id, approvalId: report.approvalId });
    } catch (err) {
      perCompany.push({ companyId: company.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { skipped: false as const, perCompany };
}
