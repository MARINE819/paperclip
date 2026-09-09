/**
 * Lifecycle wiring for the Phase 3.0B automatic reconciler, kept separate
 * from `reconcileAutomaticMemoryOperationCandidates` itself (see
 * `memory-candidate-extraction.ts`) so the reconciliation logic can be unit
 * tested without any timer, and this scheduler can be unit tested without
 * any database — matching the existing `sweepAbandonedImportTransferSpools`
 * / `importTransferSweepTimer` pattern in `server/src/app.ts`
 * (setInterval + `.unref()` + a startup-once run + swallow-and-log errors).
 *
 * Single-flight: if a tick is still running when the interval fires again,
 * the new firing is a no-op (it observes the same in-flight promise) rather
 * than starting an overlapping reconciliation pass. Phase 3.0C-1 adds one
 * structured log line for that skip (see `runTick` below) so an operator can
 * tell "no candidates" apart from "the reconciler never got to run" — no
 * change to the single-flight behavior itself.
 */

export interface MemoryCandidateReconcilerSchedulerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface MemoryCandidateReconcilerSchedulerDeps {
  /** One bounded reconciliation pass. Must not throw — but this scheduler tolerates it if it does. */
  reconcile: () => Promise<unknown>;
  intervalMs: number;
  logger: MemoryCandidateReconcilerSchedulerLogger;
  /** Injection seams for tests — never rely on real timers/sleeps. */
  setIntervalFn?: (handler: () => void, timeoutMs: number) => NodeJS.Timeout;
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
  /** Injectable clock — never call `Date.now()` directly in this module, so tests never depend on wall-clock time. */
  now?: () => number;
  /**
   * Best-effort cooldown-map size reader, read only for the tick-*failure*
   * log: a rejected `reconcile()` carries no result object to read a merged
   * `cooldownMapSize` field from (see `app.ts`'s `reconcile` closure, which
   * merges the tracker size into the *successful* result instead). Optional,
   * and any error it throws is swallowed — reading it must never make a
   * failure log itself fail.
   */
  getCooldownMapSize?: () => number;
}

export interface MemoryCandidateReconcilerScheduler {
  /** Idempotent: calling start() again while already started is a no-op. */
  start(): void;
  /** Idempotent: clears the interval and awaits any in-flight tick before resolving. */
  stop(): Promise<void>;
  /** True while a reconciliation pass is currently running — test/observability only. */
  isTickInFlight(): boolean;
}

const SKIP_LOG_MESSAGE = "memory candidate reconciliation tick skipped; previous tick still in flight";

export function createMemoryCandidateReconcilerScheduler(
  deps: MemoryCandidateReconcilerSchedulerDeps,
): MemoryCandidateReconcilerScheduler {
  const setIntervalFn = deps.setIntervalFn ?? ((handler, timeoutMs) => setInterval(handler, timeoutMs));
  const clearIntervalFn = deps.clearIntervalFn ?? ((handle) => clearInterval(handle));
  const now = deps.now ?? Date.now;

  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  // Guards against a system-clock adjustment (NTP step, VM pause/resume)
  // landing between the start and end of a tick and producing a negative
  // duration — a negative number in an operational log reads as a bug, not
  // as "the tick was fast", so it is clamped to 0 rather than reported raw.
  function elapsedMs(startedAt: number): number {
    const raw = now() - startedAt;
    return raw < 0 ? 0 : raw;
  }

  function readCooldownMapSizeSafely(): number | undefined {
    if (!deps.getCooldownMapSize) return undefined;
    try {
      return deps.getCooldownMapSize();
    } catch {
      return undefined;
    }
  }

  function runTick(): Promise<void> {
    if (inFlight) {
      // Only reachable when a previous tick (startup or a prior interval
      // firing) has not finished yet — start() calls this function at most
      // once directly, so every other call is an interval firing. No
      // document content, path, or Issue data rides this line by
      // construction: it carries no fields at all.
      deps.logger.info({}, SKIP_LOG_MESSAGE);
      return inFlight;
    }
    const startedAt = now();
    inFlight = deps
      .reconcile()
      .then((result) => {
        deps.logger.info({ result, durationMs: elapsedMs(startedAt) }, "memory candidate reconciliation tick completed");
      })
      .catch((error) => {
        // A tick failing entirely (e.g. the eligibility query itself threw)
        // must never crash the process or stop future ticks — the next
        // interval firing tries again from a clean slate.
        const cooldownMapSize = readCooldownMapSizeSafely();
        deps.logger.error(
          {
            err: error,
            durationMs: elapsedMs(startedAt),
            ...(cooldownMapSize === undefined ? {} : { cooldownMapSize }),
          },
          "memory candidate reconciliation tick failed",
        );
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    start() {
      if (timer) return; // already started
      void runTick(); // startup-once, not awaited — matches the existing sweep pattern in app.ts
      timer = setIntervalFn(() => {
        // A fake-timer test harness can still invoke this captured handler
        // directly after stop() clears the interval (clearIntervalFn is a
        // no-op against a fake handle) — this guard is what actually makes
        // post-stop firings inert, not the clearInterval call above.
        if (stopped) return;
        void runTick();
      }, deps.intervalMs);
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearIntervalFn(timer);
        timer = null;
      }
      if (inFlight) {
        await inFlight;
      }
    },
    isTickInFlight() {
      return inFlight !== null;
    },
  };
}
