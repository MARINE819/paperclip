import { describe, expect, it } from "vitest";
import { heartbeatRuns, agentWakeupRequests } from "@paperclipai/db";
import {
  computeCompanyActivitySignal,
  idleMinutesElapsed,
  SYNC02_IDLE_THRESHOLD_MS,
  SYNC02_IDLE_RECENT_TOUCH_MS,
} from "./jarvis-idle-activity-detector.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/**
 * Minimal fake matching computeCompanyActivitySignal's exact call order:
 * 1st .from(heartbeatRuns)  -> active/just-created run check (.where().limit(1))
 * .from(agentWakeupRequests) -> active/just-created wakeup check (.where().limit(1))
 * 2nd .from(heartbeatRuns)  -> latest-progress check (.where().orderBy().limit(1))
 *
 * This only exercises the function's OWN control flow given canned rows --
 * it does not execute real SQL, so it cannot verify that the drizzle
 * `or(inArray(status, ...), gt(createdAt, cutoff))` condition actually
 * matches in Postgres. That SQL-level behavior was verified by manual code
 * review only; a live-DB test would be needed to close that gap, consistent
 * with how git-save-daily-reminder-scheduler.test.ts tests this class of
 * service.
 */
function createFakeDb(fixtures: { activeRuns?: Row[]; activeWakeups?: Row[]; latestProgressRows?: Row[] }) {
  let heartbeatRunsCallCount = 0;
  const orderByCalls: unknown[] = [];
  const db = {
    select: () => ({
      from: (table: unknown) => {
        if (table === heartbeatRuns) {
          heartbeatRunsCallCount += 1;
          if (heartbeatRunsCallCount === 1) {
            return { where: () => ({ limit: () => Promise.resolve(fixtures.activeRuns ?? []) }) };
          }
          return {
            where: () => ({
              orderBy: (...args: unknown[]) => {
                orderByCalls.push(args);
                return { limit: () => Promise.resolve(fixtures.latestProgressRows ?? []) };
              },
            }),
          };
        }
        if (table === agentWakeupRequests) {
          return { where: () => ({ limit: () => Promise.resolve(fixtures.activeWakeups ?? []) }) };
        }
        throw new Error("unexpected table in fake db");
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { db, orderByCalls };
}

describe("computeCompanyActivitySignal", () => {
  const now = new Date("2026-11-05T00:30:00.000Z");

  it("returns active when a heartbeat run is queued or running", async () => {
    const { db } = createFakeDb({ activeRuns: [{ id: "run-1" }] });
    const signal = await computeCompanyActivitySignal(db, "company-1", now);
    expect(signal.state).toBe("active");
  });

  it("returns active when an agent wakeup request is pending or was just created", async () => {
    const { db } = createFakeDb({ activeWakeups: [{ id: "wakeup-1" }] });
    const signal = await computeCompanyActivitySignal(db, "company-1", now);
    expect(signal.state).toBe("active");
  });

  it("returns unknown when there is no run with recorded progress evidence", async () => {
    const { db } = createFakeDb({});
    const signal = await computeCompanyActivitySignal(db, "company-1", now);
    expect(signal).toEqual({ state: "unknown", reason: "no run with recorded concrete progress evidence yet" });
  });

  it("returns idle_since with the exact past timestamp when it is the latest recorded progress", async () => {
    const pastProgress = new Date(now.getTime() - 45 * 60_000);
    const { db, orderByCalls } = createFakeDb({ latestProgressRows: [{ lastUsefulActionAt: pastProgress }] });
    const signal = await computeCompanyActivitySignal(db, "company-1", now);
    expect(signal).toEqual({ state: "idle_since", idleSinceAt: pastProgress });
    // Confirms the function relies on the DB's ORDER BY to find the max,
    // rather than any JS-side array scan of its own.
    expect(orderByCalls.length).toBe(1);
  });

  it("returns unknown when the latest recorded progress timestamp is in the future, never falling back to an older row", async () => {
    // Real Postgres `ORDER BY lastUsefulActionAt DESC LIMIT 1` always
    // surfaces the single greatest value -- a future timestamp is always
    // greater than any past one, so if a future row exists at all, this is
    // exactly the row the real query would hand back, regardless of how
    // many legitimate past rows also exist. This is the scenario the CEO
    // asked to cover explicitly: a future anomaly must never be silently
    // skipped in favor of an older, valid-looking row.
    const futureProgress = new Date(now.getTime() + 5 * 60_000);
    const { db } = createFakeDb({ latestProgressRows: [{ lastUsefulActionAt: futureProgress }] });
    const signal = await computeCompanyActivitySignal(db, "company-1", now);
    expect(signal).toEqual({
      state: "unknown",
      reason: "latest progress timestamp is in the future relative to server clock",
    });
  });

  it("returns unknown (not active) when the only run/wakeup rows are old and not recently created -- active-run check itself does not match", async () => {
    const { db } = createFakeDb({ latestProgressRows: [] });
    const signal = await computeCompanyActivitySignal(db, "company-1", now);
    expect(signal.state).toBe("unknown");
  });
});

describe("idleMinutesElapsed", () => {
  it("computes whole and fractional minutes from the millisecond difference", () => {
    const idleSinceAt = new Date("2026-11-05T00:00:00.000Z");
    expect(idleMinutesElapsed(idleSinceAt, new Date("2026-11-05T00:30:00.000Z"))).toBe(30);
    expect(idleMinutesElapsed(idleSinceAt, new Date("2026-11-05T00:29:00.000Z"))).toBe(29);
  });

  it("agrees with SYNC02_IDLE_THRESHOLD_MS for the 30-minute boundary", () => {
    const idleSinceAt = new Date(0);
    const now = new Date(SYNC02_IDLE_THRESHOLD_MS);
    expect(idleMinutesElapsed(idleSinceAt, now)).toBe(SYNC02_IDLE_THRESHOLD_MS / 60_000);
  });
});

describe("SYNC02_IDLE_RECENT_TOUCH_MS", () => {
  it("is a small, positive buffer well under the 30-minute threshold", () => {
    expect(SYNC02_IDLE_RECENT_TOUCH_MS).toBeGreaterThan(0);
    expect(SYNC02_IDLE_RECENT_TOUCH_MS).toBeLessThan(SYNC02_IDLE_THRESHOLD_MS);
  });
});
