# Memory Candidate Extraction (NEXORA Knowledge Layer)

Deterministic extraction of Memory Operation candidates from a completed
Issue's Continuation Summary document
(`ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY`, refreshed on every heartbeat run
finalization — see `server/src/services/issue-continuation-summary.ts`). No
AI inference: this only copies a document Core already writes deterministically
into a `memory_operations` candidate row (`status: "candidate"`,
`reviewState: "pending"`), which still requires Board review and promotion
before it becomes a `knowledge_records` row.

Two triggers, sharing the same insert/idempotency logic
(`server/src/services/memory-candidate-extraction.ts`):

## Phase 3.0A — explicit, Board-triggered extraction

`POST /api/issues/:id/extract-memory-candidate`
(`extractMemoryOperationCandidateFromCompletedIssue`). A human decision to
(re-)run extraction right now for one specific Issue. Idempotency is
per-revision — the `extractionKey` includes the revision's content hash — so
calling it again after the summary content changed intentionally creates an
additional candidate for the new content. Attributed to the real calling
Board actor; activity action `memory_operation.extracted`.

## Phase 3.0B — durable automatic reconciliation

A background sweep (`reconcileAutomaticMemoryOperationCandidates`, wired into
`server/src/app.ts`'s startup/periodic scheduler) that finds completed Issues
with **no** continuation-summary-sourced candidate at all yet and extracts at
most one, ever, per Issue, automatically. It never touches `issues.ts` or
`heartbeat.ts` — it only re-derives eligibility from current DB state on each
tick, so a server restart, a missed event, or an out-of-order write can never
permanently lose an extraction the way a fire-and-forget hook could.
Attributed to `actorType: "system"`, `actorId: "memory-candidate-reconciler"`;
activity action `memory_operation.auto_created`.

If Phase 3.0A already produced a candidate for an Issue (by any actor), 3.0B
leaves it alone — it never adds a second automatic candidate, including after
a later revision of the summary appears. Phase 3.0A's own per-revision
re-extraction behavior is unaffected by 3.0B.

### Eligibility query

`findCompletedIssuesEligibleForAutomaticExtraction` joins, all scoped to the
Issue's `companyId`: `issues` (`status = 'done'`) → `issue_documents`
(`key = ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY`) → `documents` →
`document_revisions` (`documentRevisions.id = documents.latestRevisionId`),
excludes bodies that are empty after trimming all whitespace (`body ~ '\S'`,
matching JS `.trim()` semantics — plain SQL `trim()` only strips spaces, not
newlines/tabs), and excludes Issues that already have a
`memory_operations` row with `sourceType = 'document'` and
`metadata->>'extractionReason' = 'issue_completed_continuation_summary'`
(regardless of which actor created it).

Ordering is deterministic: `COALESCE(completedAt, updatedAt, createdAt)` then
`id`, so an imported Issue with a null `completedAt` still sorts stably
instead of being skipped or duplicated across ticks. No OFFSET pagination —
each tick re-derives eligibility fresh and applies a bounded `scanLimit`; a
row that succeeds simply stops matching the `NOT EXISTS` clause on the next
call.

### Starvation and failure isolation

- Each Issue in a batch is processed in its own `try/catch`; one Issue's
  failure cannot abort the batch or block Issues after it.
- `batchSize` bounds extraction *attempts* per tick, not successes.
- `scanLimit` (default `min(batchSize * 5, 500)`) is always fetched larger
  than `batchSize` so that Issues stuck in cooldown near the front of the
  deterministic order cannot crowd out healthy Issues behind them within the
  same tick.
- A failing Issue is never retried on every tick forever at full speed: it is
  tracked in a process-local, bounded, expiring **failure cooldown map**
  (`server/src/services/memory-candidate-failure-cooldown.ts`, default 5
  minute cooldown, default 500-entry cap, evicts the soonest-to-expire entry
  first when full). Cooldown skips do not count against `batchSize`. Failures
  never create a `rejected` `memory_operations` row as a poison marker — the
  cooldown state lives only in process memory.
- Explicit limitations of the cooldown map, by design: it is in-memory only
  (a process restart clears it — harmless, since the DB eligibility query is
  the durable source of truth, so the worst case is one immediate retry of a
  still-failing Issue after restart); it does not coordinate across multiple
  server instances (each instance retries independently on its own schedule;
  the `memory_operations_company_extraction_key_uq` unique constraint, not
  this map, is what keeps the *result* single).
- Log lines for a repeatedly-failing Issue are rate-limited per Issue
  (default: once per cooldown window), so a permanently broken Issue cannot
  spam the logs.

### Multi-instance safety

No new coordination mechanism: concurrent/duplicate extraction attempts
(same instance or across instances) collide on the pre-existing
`memory_operations_company_extraction_key_uq` unique constraint, and the
extraction function's catch-and-dedupe path already returns the existing row.
The candidate row and its activity log entry are always written in the same
DB transaction; `publishActivity` (the in-memory/live-event side effect) only
runs after commit, so a unique-constraint collision never produces a
duplicate activity log entry.

### Scheduler lifecycle

`server/src/services/memory-candidate-reconciler-scheduler.ts`, wired into
`server/src/app.ts` next to the existing import-transfer sweep (same shape:
`setInterval` + `.unref()` + a startup-once run + swallow-and-log):

- **Startup**: runs one reconciliation pass immediately when the scheduler is
  started (after `createApp`'s DB is ready).
- **Periodic**: re-runs every `intervalMs` on a `.unref()`'d timer so it never
  keeps the process alive on its own.
- **Single-flight**: an interval firing while a tick is still in flight is a
  no-op — it never starts an overlapping tick.
- **Shutdown**: hooked into the existing `shutdownAppServices` closure in
  `app.ts`; `stop()` clears the interval and awaits any in-flight tick before
  resolving, so a repeated `createApp()`/shutdown cycle (as in tests) never
  leaks timers.

### Observability (Phase 3.0C-1)

No new package, DB query, health/readiness field, or metrics table — this is
existing structured-log observability, hardened with three additions so an
operator reading logs (or CloudWatch/similar) can tell tick health apart
from silence:

- **Tick duration**: every completion log
  (`"memory candidate reconciliation tick completed"`) and every full-tick
  failure log (`"memory candidate reconciliation tick failed"`) now carries a
  `durationMs` field, measured via an injectable `now()` seam (never a raw
  `Date.now()` call, so tests never depend on wall-clock time). A backward
  clock step (NTP correction, VM pause/resume) clamps to `durationMs: 0`
  rather than reporting a negative number.
- **In-flight skip**: if the interval fires while the previous tick has not
  finished, the reconciler does **not** start a second pass (single-flight is
  unchanged) — it now also logs one line,
  `"memory candidate reconciliation tick skipped; previous tick still in
  flight"`, with no fields at all, so a quiet period is distinguishable from
  a reconciler that never got to run. This log call is impossible after
  `stop()`: the scheduler's own internal stopped-guard makes a post-stop
  timer firing inert.
- **Cooldown map size**: the completion log's `result` object carries a
  `cooldownMapSize` field — the process-local failure-cooldown tracker's
  current entry count at the moment the tick finished. `app.ts`'s scheduler
  `reconcile` closure merges `memoryCandidateFailureCooldown.size()` into the
  reconciliation result before returning it to the scheduler, so
  `reconcileAutomaticMemoryOperationCandidates`'s own return type is
  unchanged. The tick-failure log includes the same field on a best-effort
  basis (read independently, since a rejected `reconcile()` call carries no
  result to merge into) — its absence never breaks the failure log itself.
  The cooldown tracker itself is created once per `createApp()` call and is
  never recreated per tick.

None of this adds a document body, a file path, or Issue content to any log
line — the skip log carries no fields, and the completion/failure logs carry
only the pre-existing numeric/enum-shaped `result` fields plus `durationMs`
and `cooldownMapSize`.

### Feature flag and rollout

| Env var | Default | Notes |
| --- | --- | --- |
| `PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_ENABLED` | `false` | Only the exact string `"true"` enables it; anything else (including unset) fails closed to disabled. |
| `PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_INTERVAL_MS` | `60000` (60s) | Clamped up to a 10s minimum; malformed values fall back to the default. |
| `PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_BATCH_SIZE` | `20` | Clamped down to a 200 maximum; malformed values fall back to the default. |

The reconciler is **disabled by default** during implementation and UAT. The
default-enable decision for production is deferred until after UAT.

## Activity and actor attribution

| Trigger | Actor | Activity action |
| --- | --- | --- |
| Phase 3.0A (manual) | Real calling Board actor | `memory_operation.extracted` |
| Phase 3.0B (automatic) | `system` / `memory-candidate-reconciler` | `memory_operation.auto_created` |

Both actions insert the candidate row and its activity log entry in the same
DB transaction; both require Board review (`reviewState: "approved"`) before
`POST /api/memory-operations/:id/promote` will succeed (a premature promote
attempt returns `409` regardless of which trigger created the candidate).
