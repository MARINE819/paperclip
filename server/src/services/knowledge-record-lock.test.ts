import { describe, expect, it } from "vitest";
import { inspectKnowledgeRecordLockChains, knowledgeRecordLockKey, withKnowledgeRecordLock } from "./knowledge-record-lock.js";

async function flushMicrotasks(times = 20) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("knowledgeRecordLockKey", () => {
  it("is stable and distinguishes different companies/records", () => {
    expect(knowledgeRecordLockKey("c1", "r1")).toBe("c1:r1");
    expect(knowledgeRecordLockKey("c1", "r1")).not.toBe(knowledgeRecordLockKey("c2", "r1"));
    expect(knowledgeRecordLockKey("c1", "r1")).not.toBe(knowledgeRecordLockKey("c1", "r2"));
  });
});

describe("withKnowledgeRecordLock", () => {
  it("serializes two calls for the same key with no interleaving, no timers involved", async () => {
    const key = knowledgeRecordLockKey("c1", "r1");
    const events: string[] = [];
    const gateA = deferred<void>();

    const taskA = withKnowledgeRecordLock(key, async () => {
      events.push("A-start");
      await gateA.promise; // held open by the test until it deliberately releases it
      events.push("A-end");
      return "A";
    });

    // Queue B for the SAME key while A is still deliberately blocked. If the
    // lock were broken, B could run and finish before A is released.
    const taskB = withKnowledgeRecordLock(key, async () => {
      events.push("B-start");
      events.push("B-end");
      return "B";
    });

    // Let the event loop advance without a real lock ever letting B slip in.
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["A-start"]); // B must not have started yet

    gateA.resolve();
    const [resultA, resultB] = await Promise.all([taskA, taskB]);

    expect(resultA).toBe("A");
    expect(resultB).toBe("B");
    expect(events).toEqual(["A-start", "A-end", "B-start", "B-end"]);
  });

  it("does not serialize calls for different keys", async () => {
    const events: string[] = [];
    const gateA = deferred<void>();

    const taskA = withKnowledgeRecordLock(knowledgeRecordLockKey("c1", "r1"), async () => {
      events.push("A-start");
      await gateA.promise;
      events.push("A-end");
    });
    const taskB = withKnowledgeRecordLock(knowledgeRecordLockKey("c1", "r2"), async () => {
      events.push("B-start");
      events.push("B-end");
    });

    // B (a different key) must be able to finish while A is still blocked.
    await taskB;
    expect(events).toEqual(["A-start", "B-start", "B-end"]);

    gateA.resolve();
    await taskA;
    expect(events).toEqual(["A-start", "B-start", "B-end", "A-end"]);
  });

  it("releases the lock after a task throws, so the next queued call is not blocked forever", async () => {
    const key = knowledgeRecordLockKey("c1", "r1");
    const first = withKnowledgeRecordLock(key, async () => {
      throw new Error("boom");
    });
    const second = withKnowledgeRecordLock(key, async () => "ok");

    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("ok");
  });

  it("removes a key from the chain map once its queue is empty", async () => {
    const key = knowledgeRecordLockKey("c1", "r1");
    await withKnowledgeRecordLock(key, async () => "done");
    expect(inspectKnowledgeRecordLockChains().has(key)).toBe(false);
  });

  it("removes the key even when the sole holder throws", async () => {
    const key = knowledgeRecordLockKey("c1", "r1");
    await withKnowledgeRecordLock(key, async () => {
      throw new Error("boom");
    }).catch(() => {});
    expect(inspectKnowledgeRecordLockChains().has(key)).toBe(false);
  });

  it("leaves no chain entries behind after many sequential and concurrent keys settle", async () => {
    const keys = Array.from({ length: 10 }, (_, i) => knowledgeRecordLockKey("c1", `r${i}`));
    await Promise.all(keys.map((key) => withKnowledgeRecordLock(key, async () => key)));
    expect(inspectKnowledgeRecordLockChains().size).toBe(0);
  });

  it("serializes 5 waiters racing for the same key in strict registration order, and keeps the key present until the very last one finishes", async () => {
    // A key unique to this test: if an assertion below throws, this test's
    // own gates might be left permanently unresolved, and the module-level
    // `chains` map is shared across every test in this file — a unique key
    // keeps that failure mode from ever hanging an unrelated later test.
    const key = knowledgeRecordLockKey("c1", "r1-waiter-race");
    const events: string[] = [];
    const gates = Array.from({ length: 5 }, () => deferred<void>());

    // Register all 5 in the same synchronous tick — a genuine "waiter race"
    // to be queued for the same key, not just a two-party handoff.
    const tasks = gates.map((gate, index) =>
      withKnowledgeRecordLock(key, async () => {
        events.push(`${index}-start`);
        await gate.promise;
        events.push(`${index}-end`);
        return index;
      }),
    );

    // Immediately after registration, before anything has been released,
    // exactly the first waiter must be running and the key must still be
    // held (present in the map).
    await flushMicrotasks();
    expect(events).toEqual(["0-start"]);
    expect(inspectKnowledgeRecordLockChains().has(key)).toBe(true);

    for (let i = 0; i < gates.length; i += 1) {
      // Release exactly one waiter at a time. Releasing waiter i lets it
      // finish (push `${i}-end`) AND, in the same settle, hands the lock to
      // waiter i+1 (which immediately starts and then blocks on its own
      // still-closed gate) — so after releasing gate i, the expected trace
      // is every prior pair plus this waiter's "-end" plus the NEXT
      // waiter's "-start" (if there is one). This is pure in-memory promise
      // chaining (no real I/O), so a generous fixed number of microtask
      // flushes is fully deterministic here, unlike the HTTP-level tests
      // that involve real DB round trips.
      gates[i]!.resolve();
      await flushMicrotasks();
      const settledPairs = Array.from({ length: i + 1 }, (_, j) => [`${j}-start`, `${j}-end`]).flat();
      const isLast = i === gates.length - 1;
      const expected = isLast ? settledPairs : [...settledPairs, `${i + 1}-start`];
      expect(events).toEqual(expected);
      // The key stays held for as long as anyone — including the freshly
      // started next waiter — is still mid-flight; only the very last
      // waiter's completion clears it.
      expect(inspectKnowledgeRecordLockChains().has(key)).toBe(!isLast);
    }

    const results = await Promise.all(tasks);
    expect(results).toEqual([0, 1, 2, 3, 4]);
    expect(inspectKnowledgeRecordLockChains().has(key)).toBe(false);
  });

  it("a waiter throwing in the middle of a longer queue does not corrupt the waiters queued after it", async () => {
    const key = knowledgeRecordLockKey("c1", "r1-throw-order");
    const order: string[] = [];

    const t0 = withKnowledgeRecordLock(key, async () => {
      order.push("0"); // succeeds
      return "ok-0";
    });
    const t1 = withKnowledgeRecordLock(key, async () => {
      order.push("1"); // throws
      throw new Error("boom-1");
    });
    const t2 = withKnowledgeRecordLock(key, async () => {
      order.push("2"); // throws
      throw new Error("boom-2");
    });
    const t3 = withKnowledgeRecordLock(key, async () => {
      order.push("3"); // succeeds — must still run and must not hang
      return "ok-3";
    });

    const settled = await Promise.allSettled([t0, t1, t2, t3]);

    expect(order).toEqual(["0", "1", "2", "3"]); // strict order despite two failures in the middle
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "rejected", "rejected", "fulfilled"]);
    expect((settled[0] as PromiseFulfilledResult<string>).value).toBe("ok-0");
    expect((settled[3] as PromiseFulfilledResult<string>).value).toBe("ok-3");
    expect((settled[1] as PromiseRejectedResult).reason.message).toBe("boom-1");
    expect((settled[2] as PromiseRejectedResult).reason.message).toBe("boom-2");
    expect(inspectKnowledgeRecordLockChains().has(key)).toBe(false);
  });
});
