# Obsidian Knowledge Sync (Phase 2.2 / 2.3)

Knowledge Layer v0.1 can mirror a `knowledge_records` row to a Markdown file
inside an operator-controlled Obsidian vault. This is a manual, one-way,
Board-only export — not a live sync, not a two-way integration, and not
enabled by default.

## Scope

- **One-way only**: Paperclip writes the file. Nothing reads Obsidian back
  into Paperclip. Editing the generated file in Obsidian has no effect on
  the `knowledge_records` row and will be silently overwritten by the next
  sync.
- **Manual only**: a Board user calls the API below. There is no file
  watcher, no scheduler, and no automatic sync on promotion.
- Not included in this phase: search/indexing, bulk sync, delete sync, a UI,
  or a Paperclip plugin. See `doc/plans/2026-03-17-memory-service-surface-api.md`
  and `doc/memory-landscape.md` for the longer-term Knowledge/Memory direction.

## Configuring the vault root

Set the environment variable before starting the server:

```sh
PAPERCLIP_OBSIDIAN_VAULT_ROOT=/absolute/path/to/your/vault
```

- The path must already exist and be a real, readable/writable directory on
  the machine running the Paperclip server process.
- There is no per-company or per-user vault path in v0.1 — one server
  process has exactly one configured vault root (see
  `server/src/services/obsidian-vault-config.ts`).
- The client never supplies a vault path or a file path. The server always
  computes the relative file path itself
  (`knowledge/<slug>-<record-id>.md`, see `server/src/services/obsidian-sync.ts`),
  and re-validates it against the configured root on every call.

### Behavior when unset

If `PAPERCLIP_OBSIDIAN_VAULT_ROOT` is not set (the default), every sync
request returns a normal `200` response with:

```json
{ "obsidianSyncState": "failed", "obsidianSyncError": "Obsidian vault is not configured or not accessible on the server." }
```

No file is written and no `knowledge_records` row's `obsidianPath` is set.
This is expected, not an error condition operators need to act on unless
they intend to use this feature.

### Directory permission and read-only filesystem errors

A write can fail for ordinary filesystem reasons: the vault directory (or
one of its parents) doesn't exist, the process lacks write permission, the
filesystem is mounted read-only, or the disk is full. All of these surface
the same way — `obsidianSyncState: "failed"` with a short, fixed,
non-identifying message (`ENOENT`/`EACCES`/`EPERM`/`ENOSPC`/`EROFS` map to
distinct fixed strings in `sanitizeObsidianSyncError`). **The raw filesystem
error, including any absolute path it contains, is never persisted, logged,
or returned to the client.** If a sync keeps failing, check the server's own
process logs and the vault directory's permissions directly on the host —
the API response will not reveal more than "it failed for a filesystem
reason."

## API

```
POST /api/knowledge-records/:id/obsidian-sync
Body: {}
```

- **Board-only.** `assertBoard(req)` runs before any database lookup — an
  agent actor always gets `403`, before the server even checks whether the
  record exists or belongs to the caller's company.
- Cross-company access returns `404` (same not-found-vs-forbidden pattern
  used everywhere else in this codebase — see `getAccessibleResource` in
  `server/src/routes/authz.ts`).
- The request body must be empty; any field is rejected with `400`
  (`obsidianSyncRequestSchema` is `z.object({}).strict()`), because the
  vault path and file path are never client-supplied.
- On success: `obsidianPath`, `obsidianSyncState: "synced"`,
  `obsidianSyncError: null`, and `obsidianSyncedAt` are all updated on the
  `knowledge_records` row, and a `knowledge_record.obsidian_synced` activity
  log entry is written once.
- On failure: `obsidianSyncState: "failed"` and a sanitized
  `obsidianSyncError` are recorded; `obsidianPath` and `obsidianSyncedAt`
  are left as they were (a failed attempt never claims a path it did not
  actually write to). No activity log entry is written for a failed
  attempt.

### Activity log policy

Every genuinely **successful** sync call is logged, once, even if the file
content ends up byte-identical to the last successful sync. This is a
deliberate choice, different from the promotion API's replay guard
(`memory_operation.promoted` is skipped on an idempotent replay because
nothing was actually written the second time). A sync call is not like
that: each successful call performs a real file write and advances
`obsidianSyncedAt`/`updatedAt` on the row, so it is a real, auditable
mutation every time — collapsing it would hide genuinely-occurring writes
from the audit trail. Failed attempts are never logged, matching the
existing convention that only state-changing successes are recorded.

## Per-record locking (Phase 2.3)

Concurrent sync requests for the **same** Knowledge Record are serialized
in-process by a keyed mutex (`server/src/services/knowledge-record-lock.ts`),
keyed by `companyId:knowledgeRecordId`. Requests for **different** records
never wait on each other. The record is always re-read from the database
*after* the lock is acquired, so a queued sync always acts on the latest
row state, never on whatever a caller saw before it queued.

### Single-instance limitation

This is a plain in-memory `Map` inside one Node.js process — **not** a
distributed lock. It only serializes calls made within that one server
process.

- Running more than one Paperclip server process (a second instance, a
  second worker, a horizontally-scaled deployment) against the **same**
  vault root and the **same** database gives each process its own,
  independent lock map. Two processes can still race on the same record's
  file at that point. v0.1 does not close this gap — see "Scope exclusions"
  below.
- A crash or restart of the process drops the in-memory lock map entirely
  (by design — there is nothing to "recover"; a fresh process starts with
  an empty map and simply serializes new requests as they arrive).
- The lock never leaks: every acquisition is released in a `finally` block
  regardless of success or thrown exception, and a key is removed from the
  map as soon as nothing is queued behind its current holder — see the
  test suite in `server/src/services/knowledge-record-lock.test.ts` and
  `server/src/__tests__/obsidian-sync-concurrency.test.ts`.

### Residual TOCTOU risk

The lock only serializes *calls made through this API, in this process*. It
does not protect against:

- Another process, script, or a human directly editing files inside the
  vault directory while a sync is in flight.
- A symlink swapped into the vault *between* this server's own
  containment check and its actual write (an extremely narrow window,
  further narrowed by re-checking the real, symlink-resolved path right
  before creating the parent directory — see `resolveVaultRelativePath` in
  `server/src/services/obsidian-sync.ts` — but not eliminated, since
  filesystem state can still change between that check and the write).
- Any change to the underlying `knowledge_records` row made through a path
  other than this API while a sync is queued or running.

This TOCTOU surface is accepted for v0.1 under the threat model this
feature ships for: a single local Board operator syncing their own
records to their own vault on their own machine, not a multi-tenant or
adversarial-filesystem environment.

## Backups

`knowledge_records` rows are covered by Paperclip's normal database backups
(see `doc/DATABASE.md`). The generated Markdown files are **not** — they
live outside the database, in whatever directory the operator points
`PAPERCLIP_OBSIDIAN_VAULT_ROOT` at. If the vault matters, back it up the
way any Obsidian vault should be backed up (a real Obsidian sync plugin,
a version-controlled folder, a filesystem-level backup). Paperclip can
always regenerate the file from the database by syncing again; it cannot
recover a vault file that was only ever edited by hand and never promoted
into a `knowledge_records` row.

## Testing without a live vault or a live database

Every automated test for this feature uses:

- A throwaway directory created with `fs.mkdtemp(os.tmpdir())` as the vault
  root, removed in `afterEach` — never a real vault path.
- An isolated, temporary embedded Postgres instance
  (`useEmbeddedPostgres`/`startEmbeddedPostgresTestDatabase`, see
  `server/src/__tests__/helpers/`), started fresh per test file and torn
  down afterward — never the developer's or an operator's live database.

See `server/src/__tests__/obsidian-sync-routes.test.ts` and
`server/src/__tests__/obsidian-sync-concurrency.test.ts` for the concrete
pattern. Do not point `PAPERCLIP_OBSIDIAN_VAULT_ROOT` or `DATABASE_URL` at
anything real when adding new tests for this feature.
