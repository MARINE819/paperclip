# NEXORA F-07 — Knowledge Auto-Save Contract

**Version 1.0 — 2026-10-01.**

**Owner: Claude (backend).** This file is the authoritative contract for
`server/src/services/knowledge-auto-save-reconciler.ts`,
`server/src/services/knowledge-auto-save-scheduler.ts`,
`server/src/services/knowledge-auto-save-config.ts`, and the
`syncKnowledgeRecordToBackend` generic entry point in
`server/src/services/knowledge.ts`. Internal backend contract — F-07 ships
no new HTTP endpoint and no UI surface.

**Ships disabled by default.** `PAPERCLIP_KNOWLEDGE_AUTO_SAVE_ENABLED` must
be the exact string `"true"` for the background sweep to run at all.
Enabling it is a deliberate operator decision, matching the identical
convention already used for the Phase 3.0B memory-candidate reconciler.

## The governance model — ONE human approval covers both steps

Before this batch, promoting a memory operation into a `knowledgeRecord`
(Board-approved) and syncing that record to the configured
`KnowledgeBackend` (a *separate* Board-only action,
`POST /knowledge-records/:id/obsidian-sync`) were two independent
human-triggered steps.

**F-07 does not add a second approval gate.** The existing human
review/promotion decision — `reviewMemoryOperation` requiring
`reviewState: "approved"`, checked again by `promoteMemoryOperation` before
it will create a `knowledgeRecord` at all — now explicitly authorizes BOTH:

1. promotion into a verified `knowledgeRecord`, and
2. that record's eventual automatic write to the active `KnowledgeBackend`.

`promoteMemoryOperation` marks this authorization structurally by setting
`externalSyncState: "pending"` on the new row (previously left `NULL`). A
record with `externalSyncState = "pending"` means "a human already approved
this for automatic backend save"; nothing else sets this value to
`"pending"`.

**The manual `POST /knowledge-records/:id/obsidian-sync` endpoint remains
fully available, unrenamed, and unchanged in behavior** — it still lets a
Board actor sync any record (including one the auto-save sweep has not
reached yet, or a historical pre-F-07 record) on demand.

## Historical records are never auto-selected — no backfill

Every `knowledgeRecords` row that existed before this batch has
`externalSyncState = NULL` (the column's default, unchanged by F-08 or
F-07). **The automatic reconciler's eligibility query matches only
`externalSyncState = 'pending'` or `'failed'` — `NULL` never matches either
comparison in SQL, so historical rows are structurally excluded, not just
excluded by convention.** This batch performs no backfill and no production
historical export. A historical record remains reachable only through the
existing manual endpoint.

## Generic backend entry point — F-08 vendor independence preserved

```ts
// server/src/services/knowledge.ts
export function syncKnowledgeRecordToBackend(
  db: Db,
  backend: KnowledgeBackend,
  companyId: string,
  id: string,
): Promise<{ record: KnowledgeRecordRow; outcome: KnowledgeBackendWriteResult }>
```

This is the ONE real implementation of "knowledge record → F-08
`KnowledgeBackend` registry → active backend → `writeRecord()`". Both the
F-07 reconciler and the existing manual
`knowledgeService(db).syncKnowledgeRecordObsidian(companyId, id)` method now
call this same function — the manual method is a thin backward-compatible
delegate, not a separate implementation. **The F-07 reconciler never
imports `obsidian-sync.ts` directly** — it resolves a backend through
`getKnowledgeBackend(getActiveKnowledgeBackendId())` (the F-08 registry)
exactly like `knowledge.ts` does, so a future second backend needs no
change to the reconciler.

## Eligibility scan

`findKnowledgeRecordsEligibleForAutoSave(db, {scanLimit})` — a
migration-free, durable, re-derived-every-tick query:

```sql
SELECT id, company_id FROM knowledge_records
WHERE external_sync_state = 'pending' OR external_sync_state = 'failed'
ORDER BY updated_at ASC, id ASC
LIMIT :scanLimit
```

No `OFFSET`/cursor state: a record that gets synced simply stops matching
on the next tick, matching the exact pattern already proven by Phase 3.0B's
`findCompletedIssuesEligibleForAutomaticExtraction`.

## Execution model — reused scheduler, no new infrastructure

`createKnowledgeAutoSaveScheduler` is a renamed re-export of the existing,
already-tested `createMemoryCandidateReconcilerScheduler` factory — zero
duplicated timer/single-flight logic. Behavior: `setInterval` + `.unref()`
+ a startup-once run + single-flight (an overlapping tick is a no-op, not a
second concurrent pass) + swallow-and-log (a tick failing entirely never
crashes the process or stops future ticks).

No event bus, no message broker, no separate worker process, and no new DB
table were built — explicitly out of scope per the approved batch.

## Retry / cooldown — no new DB columns

Failure state lives entirely in the F-08 columns already added
(`externalSyncState`, `externalSyncError`) plus a process-local
`FailureCooldownTracker` (the same generic module Phase 3.0B already uses,
a separate tracker instance keyed by `knowledgeRecordId`): a failing
record is skipped (not re-attempted) for a cooldown window (default 5
minutes), then retried fresh from current DB state on a later tick. No
`nextRetryAt`/`attemptCount` DB column was added — unnecessary, since the
eligibility query already re-derives "needs attempt" from
`externalSyncState` on every tick. A process restart clears the in-memory
cooldown only, matching the identical, already-accepted reasoning
documented for the Phase 3.0B tracker — not a correctness problem, since
the DB state is the durable source of truth.

State model:

```
pending ──(write succeeds)──> synced   [excluded from all future scans]
pending ──(write fails)─────> failed ──(cooldown expires)──> retried (pending/failed again, same comparison matches) ──> synced/failed
```

## Idempotency and race prevention

- `externalRef` reuse (from F-08): a repeat write targets the same external
  location every time.
- The SAME per-record keyed mutex (`withKnowledgeRecordLock`,
  `knowledgeRecordLockKey(companyId, id)`) used by the pre-existing manual
  sync now wraps `syncKnowledgeRecordToBackend` itself — so a manual
  Board-triggered sync and an automatic reconciler attempt for the SAME
  record always serialize on the identical lock, never race, regardless of
  which one started first.

## Failure does not undo promotion

A `KnowledgeBackend.writeRecord` failure only ever updates the sync-status
columns (`externalSyncState="failed"`, `externalSyncError`) — it never
touches `memoryOperations.status` or deletes/reverts the `knowledgeRecords`
row. The verified-knowledge promotion a human already approved is
permanent regardless of whether the external write ever succeeds.

## F-05 (Tool Trust) — not wired, documented only

```
F05_TRUST_REQUIRED=NO_FOR_CURRENT_FIRST_PARTY_BACKEND
```

The current Obsidian `KnowledgeBackend` is a first-party, Claude-owned
internal service call — not an agent invoking an untrusted MCP/plugin/tool.
F-05's trust registry has no natural attachment point for this. A future
`KnowledgeBackend` implemented as an actual plugin/MCP integration (rather
than a first-party adapter, as Obsidian and any near-term Notion/Google
Drive adapter would be) may need its own F-05 review — not addressed here,
and not assumed without evidence.

## Observability

One structured log line per tick (`logger.info`/`logger.error`, via the
reused scheduler), reporting `{scanned, attempted, synced, failed,
skippedCooldown, cooldownMapSize, durationMs}` — no new observability
infrastructure.

## Design invariants

1. **One approval, two authorized effects.** No second human click is
   introduced for the backend write; the existing promotion approval
   covers it explicitly via `externalSyncState: "pending"`.
2. **Historical silence.** A `NULL` `externalSyncState` is permanently
   excluded from automatic selection — the only path to syncing such a
   record is the pre-existing manual endpoint.
3. **No duplicate architecture.** The scheduler, cooldown tracker, and
   eligibility-scan shape are all reused or directly mirrored from Phase
   3.0B, not reinvented.
4. **Vendor independence preserved.** The reconciler's only dependency on
   "how a backend writes a record" is the F-08 `KnowledgeBackend` interface.
5. **A failed external write is reversible and never destructive** — it
   only updates sync-status columns, never the knowledge record's content
   or its promoted memory operation.

## Change process

Any change to the eligibility SQL, the retry/cooldown behavior, or the
`syncKnowledgeRecordToBackend` signature must update this file in the same
change, with a version bump.
