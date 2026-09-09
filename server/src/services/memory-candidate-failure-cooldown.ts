/**
 * Process-local failure cooldown for the Phase 3.0B automatic candidate
 * reconciler (`server/src/services/memory-candidate-extraction.ts`).
 *
 * Purpose: an Issue whose extraction keeps failing (for example a
 * cross-company provenance inconsistency that should never happen but is
 * not impossible) must not (a) be retried on every single tick forever at
 * full speed, (b) spam the logs once per tick forever, or (c) permanently
 * occupy the front of the bounded per-tick scan window and starve Issues
 * behind it — see `reconcileAutomaticMemoryOperationCandidates`'s scanLimit
 * vs batchSize split for the other half of the starvation defense.
 *
 * `cooldownUntil` (blocks retries) and `lastLoggedAt` (rate-limits log
 * lines) are two independent clocks on the same entry: a failure always
 * extends the cooldown, but only refreshes `lastLoggedAt` — and therefore
 * only returns `shouldLog: true` — once `logRateLimitMs` has actually
 * elapsed since the last logged occurrence. `failureCount` keeps
 * accumulating across cooldown cycles for as long as the same Issue keeps
 * failing; only `recordSuccess` (or eviction) clears it, so an operator
 * reading the count sees a true consecutive-failure tally, not something
 * that silently resets the moment one retry window closes.
 *
 * Explicit limits, by design, not oversights:
 * - This state is in-memory only. A process restart clears it completely —
 *   that is intentional (see the module doc on
 *   `memory-candidate-extraction.ts`): the DB itself is the durable
 *   eligibility source of truth, so losing the cooldown map on restart only
 *   means "the next tick may retry a still-failing Issue immediately",
 *   never a correctness problem.
 * - This state does not coordinate across multiple server instances. Two
 *   instances can each independently retry the same failing Issue on their
 *   own cooldown schedule; the `extractionKey` unique constraint is what
 *   keeps the *result* single, not this map.
 * - The map is bounded (`maxEntries`, default 500) and evicts the
 *   soonest-to-expire entries first when full, so a pathological number of
 *   distinct failing Issues cannot grow this unboundedly.
 */

export interface FailureCooldownTrackerOptions {
  /** How long a key is skipped after a failure. Default 5 minutes. */
  cooldownMs?: number;
  /** Minimum gap between two log lines for the same key. Default equals cooldownMs. */
  logRateLimitMs?: number;
  /** Hard cap on distinct tracked keys. Default 500. */
  maxEntries?: number;
  /** Injectable clock for deterministic tests — never real sleeps. */
  now?: () => number;
}

export interface FailureCooldownTracker {
  /** True if `key` is currently cooling down and should be skipped without counting as an attempt. */
  isInCooldown(key: string): boolean;
  /** Records a failure for `key`. Returns whether this failure should be logged (rate-limited per key). */
  recordFailure(key: string): { shouldLog: boolean; failureCount: number };
  /** Clears all tracked state for `key` after a successful attempt. */
  recordSuccess(key: string): void;
  /** Current number of tracked keys — for tests and bounded-size verification. */
  size(): number;
}

interface CooldownEntry {
  cooldownUntil: number;
  lastLoggedAt: number;
  failureCount: number;
}

const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 500;

export function createFailureCooldownTracker(
  options: FailureCooldownTrackerOptions = {},
): FailureCooldownTracker {
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const logRateLimitMs = options.logRateLimitMs ?? cooldownMs;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  const entries = new Map<string, CooldownEntry>();

  function enforceBound() {
    if (entries.size <= maxEntries) return;
    const bySoonestCooldownExpiry = [...entries.entries()]
      .sort((a, b) => a[1].cooldownUntil - b[1].cooldownUntil);
    const overflow = entries.size - maxEntries;
    for (let i = 0; i < overflow; i += 1) {
      entries.delete(bySoonestCooldownExpiry[i]![0]);
    }
  }

  return {
    isInCooldown(key: string): boolean {
      const entry = entries.get(key);
      return entry !== undefined && entry.cooldownUntil > now();
    },
    recordFailure(key: string): { shouldLog: boolean; failureCount: number } {
      const current = now();
      const existing = entries.get(key);
      const failureCount = (existing?.failureCount ?? 0) + 1;
      const shouldLog = !existing || current - existing.lastLoggedAt >= logRateLimitMs;
      entries.set(key, {
        cooldownUntil: current + cooldownMs,
        lastLoggedAt: shouldLog ? current : existing!.lastLoggedAt,
        failureCount,
      });
      enforceBound();
      return { shouldLog, failureCount };
    },
    recordSuccess(key: string): void {
      entries.delete(key);
    },
    size(): number {
      return entries.size;
    },
  };
}
