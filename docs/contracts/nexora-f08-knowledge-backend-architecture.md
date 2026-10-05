# NEXORA F-08 — Pluggable Knowledge Backend Architecture Contract

**Version 1.0 — 2026-10-01.**

**Owner: Claude (backend/architecture).** This file is the authoritative
contract for `server/src/services/knowledge-backend.ts`,
`server/src/services/obsidian-sync.ts` (as the v1 backend implementation),
`server/src/services/knowledge.ts`, and the `external*` columns on
`packages/db/src/schema/knowledge_records.ts`. This is an internal backend
contract, not an Antigravity-facing API contract — F-08 ships no new HTTP
endpoint and no UI surface in this batch.

**Scope — v1 ships exactly one real backend.** Obsidian is the first and
only `KnowledgeBackend` implementation. This batch does NOT implement
Notion, Google Drive, a wiki, bidirectional sync, multi-backend fan-out, a
per-company backend-selection table, or F-07 automatic saving.

## Why this exists

Before this batch, `server/src/services/knowledge.ts` imported
`syncKnowledgeRecordToObsidian` directly, and `knowledge_records` had four
Obsidian-named columns (`obsidianPath`/`obsidianSyncState`/
`obsidianSyncError`/`obsidianSyncedAt`) and a shared type literally named
`ObsidianSyncState`. Any future second backend (Notion, Google Drive, an
internal wiki) would have had to either imitate Obsidian's shape or force
another ad-hoc branch into `knowledge.ts`. F-08 inserts the smallest
interface that removes that coupling, without building infrastructure for
backends that don't exist yet.

## `KnowledgeBackend` interface

```ts
// server/src/services/knowledge-backend.ts

interface KnowledgeBackend {
  id: string; // stable identifier, e.g. "obsidian"
  capabilities: {
    write: boolean;
    read: boolean; // reserved — no backend implements this in v1
  };
  writeRecord(input: KnowledgeBackendWriteInput): Promise<KnowledgeBackendWriteResult>;
}

type KnowledgeBackendWriteInput = {
  id: string;
  companyId: string;
  title: string;
  summary: string | null;
  body: string;
  externalRef: string | null; // the backend's own pointer from a prior write, or null
};

type KnowledgeBackendWriteResult =
  | { state: "synced"; externalRef: string }
  | { state: "failed"; error: string };
```

There is deliberately no `readRecord` method, no CRUD surface, and no batch/
fan-out method. `capabilities.read` exists only so a future read-capable
backend has a place to declare that fact — nothing in this codebase checks
it yet.

## Registry behavior

`getKnowledgeBackend(id, options?)` resolves a backend by id.
**Unknown id fails closed** — it throws `UnknownKnowledgeBackendError`
rather than silently falling back to Obsidian or any other default. There is
exactly one registered id today: `"obsidian"`.

```ts
getKnowledgeBackend("obsidian") // -> KnowledgeBackend
getKnowledgeBackend("notion")   // -> throws UnknownKnowledgeBackendError
```

This mirrors the registration-pattern precedent already established by
`server/src/adapters/registry.ts` (F-09) and
`server/src/storage/provider-registry.ts` — a small lookup function, not a
new architectural style.

## Active backend configuration

**v1: one active Knowledge Backend per server instance**, selected by a
server-owned environment variable — the same convention already used by
`obsidian-vault-config.ts` (`PAPERCLIP_OBSIDIAN_VAULT_ROOT`) and
`storage/provider-registry.ts` (`storageProvider` config).

```
PAPERCLIP_KNOWLEDGE_BACKEND=obsidian   # default when unset
```

There is no DB-stored backend-selection table, no per-company backend
choice, and no fan-out to multiple backends. `getActiveKnowledgeBackendId()`
defaults to `"obsidian"` when the env var is unset or empty — the only real
backend, so this is never ambiguous in v1.

## `writeRecord` input/output

- Input is a plain projection of the `knowledgeRecords` row the caller
  already has, plus `externalRef` — the backend's own prior pointer for this
  record (e.g. Obsidian's vault-relative path), or `null` if never
  synced. This lets a backend produce the SAME external location on a
  repeat/idempotent sync rather than drifting.
- Output is a two-state result, never throws: `{state:"synced",externalRef}`
  on success, `{state:"failed",error}` on any failure. `error` is always a
  short, sanitized, non-identifying message — see `sanitizeObsidianSyncError`
  for the Obsidian backend's own sanitization rules (unchanged by this
  batch).

## Final generic DB fields (`knowledge_records`, additive only)

| Column | Type | Meaning |
|---|---|---|
| `externalBackendId` | `text`, nullable | The `KnowledgeBackend.id` that performed the most recent write attempt (e.g. `"obsidian"`). Set on every attempt, synced or failed. |
| `externalSyncState` | `text` (`KnowledgeSyncState`), nullable | `"pending"` \| `"synced"` \| `"failed"`. |
| `externalSyncError` | `text`, nullable | Sanitized failure reason; `null` on success. |
| `externalSyncedAt` | `timestamptz`, nullable | Set only on a successful write; untouched on failure (never cleared). |
| `externalRef` | `text`, nullable | The backend's own returned pointer (e.g. vault-relative path for Obsidian). Untouched on failure — a failed attempt never claims a location it did not actually write to. |

`externalRef` was added after Phase-0 planning specifically because
`writeRecord`'s result always returns it on success — persisting the
interface's own output is required, not optional; omitting it would have
silently dropped data the interface promises to produce.

### Backward compatibility — the four `obsidian*` columns are unchanged

`obsidianPath`/`obsidianSyncState`/`obsidianSyncError`/`obsidianSyncedAt`
are **not** renamed, dropped, or deprecated in this batch. Every sync
attempt writes BOTH the old Obsidian-named columns and the new generic
columns, with identical values (`obsidianPath` === `externalRef`,
`obsidianSyncState` === `externalSyncState`, etc.), so any existing or
in-flight consumer of the old names keeps working unchanged. A future,
separately-approved batch may retire the old columns once nothing reads
them — not done here.

`ObsidianSyncState` (shared type) is now a compatible alias of the new
`KnowledgeSyncState` type (identical literal union
`"pending"|"synced"|"failed"`) — existing imports of `ObsidianSyncState`
continue to resolve to the same type.

## Obsidian as the v1 backend

`createObsidianKnowledgeBackend()` wraps the **existing, unmodified**
`syncKnowledgeRecordToObsidian()` from `obsidian-sync.ts`. None of the
following changed in this batch: vault containment validation (symlink
re-check included), Markdown rendering, YAML frontmatter escaping,
temp-file-then-atomic-rename write behavior, or sanitized error mapping.
The adapter only translates between the generic interface shape and the
pre-existing `(vaultRoot, record) -> ObsidianSyncOutcome` function signature
— a pure mapping layer, not a rewrite.

## Fail-closed behavior

- Unknown backend id → throws, never silently defaults to Obsidian.
- A write failure never claims a location it didn't write to (`externalRef`/
  `obsidianPath` stay at their prior value on failure).
- `capabilities.read: false` for every v1 backend — nothing in this system
  attempts to read a record back from an external backend.

## Provenance

Unchanged. `buildKnowledgeProvenanceSnapshot()` /
`knowledgeRecords.metadata.provenance` already captured
sourceType/sourceId/sourceIssueId/sourceRunId/sourceAgentId/
memoryOperationId/capturedAt before this batch and needed no change — it is
backend-agnostic by construction.

## Locking

Unchanged. The per-`(companyId, knowledgeRecordId)` keyed mutex
(`knowledge-record-lock.ts`) still wraps the entire sync attempt in
`knowledge.ts`, including the new backend-registry call — concurrent syncs
for the same record still serialize; different records still never wait on
each other.

## Human Approval behavior

Unchanged. `POST /knowledge-records/:id/obsidian-sync` remains Board-only
(`assertBoard`, checked before any DB lookup) — syncing to an external
knowledge backend stays a human-governed action, never delegated to an
agent actor. The route path itself is unchanged in this batch (still
`/obsidian-sync`, matching the one real backend); a future second backend
would need its own route-naming decision, not addressed here.

## Non-goals (explicitly out of scope this batch)

- Notion, Google Drive, or wiki implementations.
- A `readRecord` method or any read-back capability.
- Bidirectional sync or conflict resolution.
- Fan-out to multiple simultaneous backends.
- A DB-stored, per-company backend-selection table.
- Any backend-selection UI.
- F-07 automatic/background saving (this interface is what F-07 should call
  once scoped — see below — not something F-07 implements itself).

## Future F-02 (Secrets) integration

Not implemented. Obsidian needs no credential (filesystem path only). A
future OAuth/API-key-based backend (Notion, Google Drive) should obtain its
credentials through the existing `company_secrets`/`secrets-registry.ts`
system at call time, inside that backend's own `writeRecord` implementation
— never stored on the generic `KnowledgeBackend` interface itself, and never
built speculatively ahead of a real second backend needing it.

## Future F-07 integration

F-07 (automatic/background knowledge saving) should call
`getKnowledgeBackend(...).writeRecord(...)` through this registry, exactly
as `knowledge.ts` now does, rather than importing `obsidian-sync.ts`
directly — this was the specific coupling this batch exists to prevent.
Whether F-07's automatic trigger needs its own Human Approval Gate or
F-05 tool-trust integration is an open question for F-07's own scoping, not
decided here — see `docs/investigations/nexora-f08-knowledge-backend-architecture-report.md`.

## Future F-05 (Tool Trust) integration

Not implemented and not clearly needed yet: today's sync is a direct human
Board action, not an agent/tool-initiated call. Revisit only when F-07
autonomous/background saving is scoped.

## Requirements for a future second backend implementer

1. Implement `KnowledgeBackend` (`id`, `capabilities`, `writeRecord`).
2. Register it in `getKnowledgeBackend()`'s id switch.
3. If it needs credentials, read them from the F-02 secrets system inside
   `writeRecord`, never on the interface.
4. Decide and document its own capability flags honestly — do not claim
   `read: true` without implementing and testing a read path.
5. `writeRecord` must never throw — every failure mode returns
   `{state:"failed", error}` with a sanitized, non-identifying message.

## Change process

Any change to the `KnowledgeBackend` interface shape, the registry's id
switch, or the generic DB field set must update this file in the same
change, with a version bump.
