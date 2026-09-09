/**
 * Phase 2.3: per-Knowledge-Record serialization for Obsidian sync.
 *
 * This is a process-local keyed mutex, not a distributed lock. It only
 * serializes calls made within this one Node.js process. See
 * `doc/obsidian-knowledge-sync.md` for the full single-instance limitation
 * and the residual TOCTOU risk this does and does not close.
 *
 * Design: a chain of promises per key. Acquiring the lock for a key means
 * waiting for the previous holder's `gate` to settle; the gate always
 * settles (it is never rejected), so one task throwing can never leave the
 * next queued caller waiting forever. The map entry for a key is deleted
 * once nobody has queued behind the current holder, so keys that are no
 * longer contended do not accumulate in memory.
 */

const chains = new Map<string, Promise<void>>();

/** Test/observability only: never mutate the returned map. */
export function inspectKnowledgeRecordLockChains(): ReadonlyMap<string, Promise<void>> {
  return chains;
}

export function knowledgeRecordLockKey(companyId: string, knowledgeRecordId: string): string {
  return `${companyId}:${knowledgeRecordId}`;
}

/**
 * Runs `task` after every previously queued call for the same `key` has
 * fully finished (success or failure), and before any call queued after it.
 * Different keys never wait on each other.
 */
export async function withKnowledgeRecordLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();

  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  // `gate` never rejects, so this key's chain can never get stuck even if
  // every queued task throws.
  const ourTail = previous.then(
    () => gate,
    () => gate,
  );
  chains.set(key, ourTail);

  await previous;
  try {
    return await task();
  } finally {
    openGate();
    // Only the most recently queued caller for this key is allowed to
    // remove it — an earlier caller whose tail has since been replaced by a
    // newer waiter must leave the entry for that waiter to clean up.
    if (chains.get(key) === ourTail) {
      chains.delete(key);
    }
  }
}
