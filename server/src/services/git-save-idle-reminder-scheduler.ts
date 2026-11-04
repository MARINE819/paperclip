import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import {
  createMemoryCandidateReconcilerScheduler as createGitSaveIdleReminderScheduler,
  type MemoryCandidateReconcilerSchedulerLogger as GitSaveIdleReminderSchedulerLogger,
  type MemoryCandidateReconcilerScheduler as GitSaveIdleReminderScheduler,
} from "./memory-candidate-reconciler-scheduler.js";
import { generateDailyGitSaveReportAndApproval } from "./jarvis-daily-save-report.js";
import {
  computeCompanyActivitySignal,
  idleMinutesElapsed,
  SYNC02_IDLE_THRESHOLD_MS,
} from "./jarvis-idle-activity-detector.js";

/**
 * SYNC-02 Stage A: unattended, idle-triggered (30-minute company-wide
 * inactivity) Git-save reminder. Reuses the exact same scheduler factory as
 * the 21:00 KST daily reminder (setInterval + `.unref()` + startup-once +
 * single-flight + swallow-and-log) -- only the per-tick trigger condition
 * differs (idle duration here, a fixed KST hour there). This file never
 * touches routes/issues.ts, Atlas, or heartbeat.ts, and never calls
 * git-save-prepare.mjs/git-save.mjs/approves anything on its own --
 * generateDailyGitSaveReportAndApproval only ever creates a CEO-visible
 * board approval. Wiring this into app.ts (behind a default-disabled env
 * flag, mirroring the daily reminder's wiring exactly) is a separate,
 * explicitly-approved step.
 */
export {
  createGitSaveIdleReminderScheduler,
  type GitSaveIdleReminderScheduler,
  type GitSaveIdleReminderSchedulerLogger,
};

export interface RunGitSaveIdleReminderTickInput {
  db: Db;
  repoRoot: string;
  now?: () => Date;
}

export interface GitSaveIdleReminderPerCompanyResult {
  companyId: string;
  skipped?: "active" | "unknown" | "idle_below_threshold" | "no_jarvis_agent";
  approvalId?: string | null;
  outcome?: string;
  error?: string;
}

export interface RunGitSaveIdleReminderTickResult {
  perCompany: GitSaveIdleReminderPerCompanyResult[];
}

export async function runGitSaveIdleReminderTick(
  input: RunGitSaveIdleReminderTickInput,
): Promise<RunGitSaveIdleReminderTickResult> {
  const now = input.now ?? (() => new Date());
  const companyRows = await input.db.select({ id: companies.id }).from(companies);
  const perCompany: GitSaveIdleReminderPerCompanyResult[] = [];

  for (const company of companyRows) {
    try {
      const signal = await computeCompanyActivitySignal(input.db, company.id, now());
      if (signal.state === "active") {
        perCompany.push({ companyId: company.id, skipped: "active" });
        continue;
      }
      if (signal.state === "unknown") {
        perCompany.push({ companyId: company.id, skipped: "unknown" });
        continue;
      }

      const idleMinutes = idleMinutesElapsed(signal.idleSinceAt, now());
      if (idleMinutes < SYNC02_IDLE_THRESHOLD_MS / 60_000) {
        perCompany.push({ companyId: company.id, skipped: "idle_below_threshold" });
        continue;
      }

      const [jarvisAgent] = await input.db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, company.id), eq(agents.name, "JARVIS")));
      if (!jarvisAgent) {
        perCompany.push({ companyId: company.id, skipped: "no_jarvis_agent" });
        continue;
      }

      const report = await generateDailyGitSaveReportAndApproval({
        db: input.db,
        companyId: company.id,
        jarvisAgentId: jarvisAgent.id,
        repoRoot: input.repoRoot,
        source: "sync02_idle_30min",
        idleSinceAt: signal.idleSinceAt,
        now,
      });
      perCompany.push({ companyId: company.id, approvalId: report.approvalId, outcome: report.outcome });
    } catch (err) {
      perCompany.push({ companyId: company.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { perCompany };
}
