import { and, desc, eq, gt, inArray, isNotNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, heartbeatRuns } from "@paperclipai/db";

/**
 * SYNC-02 Stage A: company-wide "has any AI employee made real progress
 * recently" signal, reused by the idle-triggered daily-save-report reminder.
 * READ-ONLY -- three plain SELECTs, no writes, no git/process access.
 *
 * Fail-safe by construction: any ambiguity (no run history yet, no run with
 * concrete progress evidence yet, a run/wakeup request that is queued,
 * running, or JUST created, or the latest progress timestamp being in the
 * future) resolves to "active" or "unknown", never to "idle". A future
 * timestamp is treated as a trust failure for the whole signal -- it is
 * never silently skipped in favor of an older, valid-looking row.
 *
 * Scope note: this decides only WHEN the existing report should be
 * generated. It never reclassifies what counts as save-ready -- that stays
 * entirely the unmodified git-save-collect-daily.mjs collector's job.
 */

export type CompanyActivitySignal =
  | { state: "active"; reason: string }
  | { state: "unknown"; reason: string }
  | { state: "idle_since"; idleSinceAt: Date };

const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;
const ACTIVE_WAKEUP_STATUSES = ["queued", "deferred_issue_execution", "claimed"] as const;

export const SYNC02_IDLE_THRESHOLD_MS = 30 * 60_000;

export const SYNC02_IDLE_RECENT_TOUCH_MS = 10_000;

export function idleMinutesElapsed(idleSinceAt: Date, now: Date): number {
  return (now.getTime() - idleSinceAt.getTime()) / 60_000;
}

export async function computeCompanyActivitySignal(
  db: Db,
  companyId: string,
  now: Date,
): Promise<CompanyActivitySignal> {
  const recentTouchCutoff = new Date(now.getTime() - SYNC02_IDLE_RECENT_TOUCH_MS);

  const activeOrJustCreatedRuns = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        or(
          inArray(heartbeatRuns.status, ACTIVE_RUN_STATUSES),
          gt(heartbeatRuns.createdAt, recentTouchCutoff),
        ),
      ),
    )
    .limit(1);
  if (activeOrJustCreatedRuns.length > 0) {
    return { state: "active", reason: "a heartbeat run is queued, running, or was just created" };
  }

  const activeOrJustCreatedWakeups = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, companyId),
        or(
          inArray(agentWakeupRequests.status, ACTIVE_WAKEUP_STATUSES),
          gt(agentWakeupRequests.requestedAt, recentTouchCutoff),
        ),
      ),
    )
    .limit(1);
  if (activeOrJustCreatedWakeups.length > 0) {
    return { state: "active", reason: "an agent wakeup request is pending or was just created" };
  }

  const [latestProgress] = await db
    .select({ lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        isNotNull(heartbeatRuns.lastUsefulActionAt),
      ),
    )
    .orderBy(desc(heartbeatRuns.lastUsefulActionAt))
    .limit(1);

  if (!latestProgress?.lastUsefulActionAt) {
    return { state: "unknown", reason: "no run with recorded concrete progress evidence yet" };
  }

  const lastUsefulActionAt = new Date(latestProgress.lastUsefulActionAt);

  if (lastUsefulActionAt.getTime() > now.getTime()) {
    return { state: "unknown", reason: "latest progress timestamp is in the future relative to server clock" };
  }

  return { state: "idle_since", idleSinceAt: lastUsefulActionAt };
}
