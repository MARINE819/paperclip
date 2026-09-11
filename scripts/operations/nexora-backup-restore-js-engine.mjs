import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
// This file lives in scripts/operations/, which is not itself an npm
// package and has no node_modules of its own, so the bare specifier
// "postgres" does not resolve from here (confirmed by direct invocation:
// ERR_MODULE_NOT_FOUND). A static ESM import specifier must be a literal
// string, so this imports the exact on-disk pnpm-installed copy that
// packages/db already depends on (same package client.ts/backup-lib.ts use)
// via its absolute file:// URL, avoiding both that failure and any need to
// move this pinned, already-hash-checked helper file.
import postgres from "file:///C:/Users/Nexora/paperclip/packages/db/node_modules/postgres/src/index.js";

const BACKUP_SHA256 = "0AA1AA15F6950C669D0175F647D52CBF2296CA9457A6D49AF1112FB1BB460BB9";
const BACKUP_PATH = "C:\\Users\\Nexora\\.paperclip\\instances\\default\\data\\backups\\paperclip-20260831-220448.sql.gz";
const TEMP_ROOT = "C:\\Users\\Nexora\\AppData\\Local\\Temp\\nexora-restore-test-20260831-220448-0aa1aa15-retry8";
const PGDATA = TEMP_ROOT + "\\pgdata";
const EVIDENCE_DIR = TEMP_ROOT + "\\evidence";
const ENGINE_ORIGIN = "nexora-direct-js-statement-engine-v1";
const BREAKPOINT = "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900";
const NETSTAT = "C:\\Windows\\System32\\netstat.exe";
const EXPECTED = new Map([[3100, 13548], [54329, 18716], [54330, 16208]]);
const EXPECTED_CANARY_CLIENT_PID = 15228;

// Guard 16 / Evidence Bundle constants. These are the pinned expectations for
// THIS one pre-approved backup snapshot only (matching the same manifest that
// pins the backup path/hash/size above) -- never derived from, and never
// compared against, the live default (54329) or Canary (54330) databases.
const EXPECTED_ROW_COUNTS = {
  companies: 1,
  agents: 10,
  projects: 2,
  goals: 1,
  issues: 112,
  issue_comments: 393,
  approvals: 16,
  issue_approvals: 14,
  heartbeat_runs: 454,
  heartbeat_run_events: 2765,
  activity_log: 2205,
  plugin_database_namespaces: 0,
  plugin_migrations: 0,
};
// A broader existence-only check (not row-count-pinned): every table Guard 16
// treats as critical enough that its absence alone must fail verification.
const CRITICAL_TABLES = [
  ...Object.keys(EXPECTED_ROW_COUNTS),
  "knowledge_records",
  "memory_operations",
  "issue_work_products",
];
// Verified directly against packages/db/src/migrations/0173_inbox_policy_agent_cleanup.sql
// and 0227_modern_pandemic.sql (both CREATE, neither later dropped).
const EXPECTED_FUNCTIONS = [
  "remove_deleted_agent_from_inbox_policy_allowlists",
  "paperclip_bump_issue_status_version",
];
const APPROVAL_TTL_COLUMNS = ["expires_at", "task_fingerprint", "consumed_at", "consumed_by_run_id", "superseded_by_approval_id"];
const APPROVAL_TTL_INDEXES = ["approvals_company_status_type_idx", "approvals_company_fingerprint_idx"];

class HarnessAbort extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const abort = (code) => { throw new HarnessAbort(code); };

function canonical(value) {
  return path.win32.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
}

function assertInputs(backupFile, expectedDataDir, expectedPostgresPid, evidenceDir) {
  if (canonical(backupFile) !== canonical(BACKUP_PATH)) abort("ABORT_HELPER_BACKUP_PATH");
  if (canonical(expectedDataDir) !== canonical(PGDATA)) abort("ABORT_HELPER_PGDATA");
  if (canonical(evidenceDir) !== canonical(EVIDENCE_DIR)) abort("ABORT_HELPER_EVIDENCE_DIR");
  if (!Number.isInteger(expectedPostgresPid) || expectedPostgresPid <= 0 || [...EXPECTED.values(), EXPECTED_CANARY_CLIENT_PID].includes(expectedPostgresPid)) {
    abort("ABORT_HELPER_POSTGRES_PID");
  }
}

function assertEngineIsolation() {
  if (process.env.PAPERCLIP_PSQL_PATH) abort("ABORT_PSQL_OVERRIDE");
  if (process.env.DATABASE_URL) abort("ABORT_DATABASE_URL");
  const suffixes = process.platform === "win32" ? ["", ".com", ".exe", ".bat", ".cmd"] : [""];
  for (const directory of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const base of ["psql", "pg_restore"]) {
      for (const suffix of suffixes) {
        if (existsSync(path.join(directory, `${base}${suffix}`))) abort("ABORT_ENGINE_DRIFT");
      }
    }
  }
}

function tcpRows() {
  let output;
  try {
    output = execFileSync(NETSTAT, ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true, timeout: 500 });
  } catch {
    abort("ABORT_TCP_STATE_UNKNOWN");
  }
  const rows = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+(\S+):(\d+)\s+(\S+):(\d+)\s+(\S+)\s+(\d+)\s*$/);
    if (!match) continue;
    rows.push({
      localAddress: match[1], localPort: Number(match[2]),
      remoteAddress: match[3], remotePort: Number(match[4]),
      state: match[5], pid: Number(match[6]),
    });
  }
  return rows;
}

async function assertProtectedBaseline(rows) {
  for (const [port, pid] of EXPECTED) {
    const listeners = rows.filter((row) => row.localPort === port && row.state === "LISTENING");
    if (listeners.length !== 1 || listeners[0].localAddress !== "127.0.0.1" || listeners[0].pid !== pid) {
      abort("ABORT_PROTECTED_BASELINE");
    }
  }
  if (!rows.some((row) => row.remotePort === 54330 && row.state === "ESTABLISHED" && row.pid === EXPECTED_CANARY_CLIENT_PID)) {
    abort("ABORT_CANARY_CLIENT");
  }
  let response;
  try {
    response = await fetch("http://127.0.0.1:3100/api/health/ready", { signal: AbortSignal.timeout(500) });
    if (!response.ok || (await response.json()).status !== "ready") abort("ABORT_API_HEALTH");
  } catch (error) {
    if (error instanceof HarnessAbort) throw error;
    abort("ABORT_API_HEALTH");
  }
}

function assertOnlyExpectedTargetConnection(rows, postgresPid) {
  const listeners = rows.filter((row) => row.localPort === 55432 && row.state === "LISTENING");
  if (listeners.length !== 1 || listeners[0].localAddress !== "127.0.0.1" || listeners[0].pid !== postgresPid) {
    abort("ABORT_POSTGRES_IDENTITY");
  }
  const relevant = rows.filter((row) => row.state === "ESTABLISHED" && (row.localPort === 55432 || row.remotePort === 55432));
  if (relevant.length !== 2) abort("ABORT_UNEXPECTED_55432_CLIENT");
  const client = relevant.find((row) => row.remotePort === 55432 && row.pid === process.pid);
  const server = relevant.find((row) => row.localPort === 55432 && row.pid === postgresPid);
  if (!client || !server || client.localAddress !== "127.0.0.1" || client.remoteAddress !== "127.0.0.1" ||
      server.localAddress !== "127.0.0.1" || server.remoteAddress !== "127.0.0.1" ||
      client.localPort !== server.remotePort || client.remotePort !== server.localPort) {
    abort("ABORT_UNEXPECTED_55432_CLIENT");
  }
}

async function* readStatements(backupFile) {
  const raw = createReadStream(backupFile);
  const stream = raw.pipe(createGunzip());
  stream.setEncoding("utf8");
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let lines = [];
  // Tracks whether the current position is inside a COPY ... FROM stdin;
  // data block (terminated by a line containing exactly "\."), so that a
  // breakpoint marker landing inside that block is never treated as a
  // statement separator -- doing so would split the COPY header from its
  // own data rows, sending a bare data row to Postgres as its own
  // "statement" (confirmed root cause of the retry4 42601 syntax error).
  let inCopyData = false;
  const flush = () => {
    const statement = lines.join("\n").trim();
    lines = [];
    return statement;
  };
  try {
    for await (const line of reader) {
      if (!inCopyData && line === BREAKPOINT) {
        const statement = flush();
        if (statement) yield statement;
        continue;
      }
      lines.push(line);
      if (!inCopyData && /^COPY\s+\S.*\bFROM\s+stdin;\s*$/i.test(line)) {
        inCopyData = true;
      } else if (inCopyData && line === "\\.") {
        inCopyData = false;
      }
    }
    const trailing = flush();
    if (trailing) yield trailing;
  } finally {
    reader.close();
    stream.destroy();
    raw.destroy();
  }
}

// Parses a dot-separated identifier where each part may or may not be
// double-quoted (matches both this backup engine's `"schema"."table"` output
// and a plain `schema.table`/`table` form). Returns null on anything that
// doesn't fully resolve to 1 or 2 clean parts -- callers must treat that as
// an extraction failure, never guess a name.
function parseQualifiedIdentifier(raw) {
  const parts = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '"') {
      const end = raw.indexOf('"', i + 1);
      if (end === -1) return null;
      parts.push(raw.slice(i + 1, end));
      i = end + 1;
    } else {
      const match = raw.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (!match) return null;
      parts.push(match[0]);
      i += match[0].length;
    }
    if (i < raw.length) {
      if (raw[i] !== ".") return null;
      i += 1;
    }
  }
  if (parts.length === 1) return `public.${parts[0]}`;
  if (parts.length === 2) return `${parts[0]}.${parts[1]}`;
  return null;
}

// Trigger names are single (non-schema-qualified) identifiers in PostgreSQL.
function parseSimpleIdentifier(raw) {
  const quoted = raw.match(/^"([^"]+)"/);
  if (quoted) return quoted[1];
  const bare = raw.match(/^[A-Za-z_][A-Za-z0-9_]*/);
  return bare ? bare[0] : null;
}

// Reads the expected base-table and trigger identifiers directly out of the
// pinned backup's own DDL text -- never from the current migrations/repo
// state, which may be ahead of or behind whatever this specific snapshot
// actually contains. Returns null (never a partial/best-effort list) if any
// CREATE TABLE/TRIGGER line's identifier can't be parsed unambiguously, or if
// zero tables were found at all -- callers must fail closed on null rather
// than compare against a guessed expectation.
async function extractExpectedSchemaObjects(backupFile) {
  const raw = createReadStream(backupFile);
  const stream = raw.pipe(createGunzip());
  stream.setEncoding("utf8");
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  const tables = [];
  const triggers = [];
  let ambiguous = false;
  try {
    for await (const line of reader) {
      const tableMatch = line.match(/^CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\S+)\s*\(/i);
      if (tableMatch) {
        const identifier = parseQualifiedIdentifier(tableMatch[1]);
        if (!identifier) { ambiguous = true; break; }
        tables.push(identifier);
      }
      const triggerMatch = line.match(/^CREATE TRIGGER\s+(\S+)/i);
      if (triggerMatch) {
        const name = parseSimpleIdentifier(triggerMatch[1]);
        if (!name) { ambiguous = true; break; }
        triggers.push(name);
      }
    }
  } finally {
    reader.close();
    stream.destroy();
    raw.destroy();
  }
  if (ambiguous || tables.length === 0) return null;
  return { tables, triggers };
}

// A chunk is COPY-shaped iff it contains both a "COPY ... FROM stdin;"
// header line and a lone "\." terminator line -- the same two markers
// readStatements() already uses to track inCopyData.
function isCopyChunk(statementText) {
  return /^COPY\s+\S.*\bFROM\s+stdin;\s*$/im.test(statementText) && /^\\\.$/m.test(statementText);
}

// Splits a COPY-shaped chunk into its header line and raw data lines. Never
// returns or logs the data lines' content -- callers stream them directly.
// Returns null if the chunk is not a single, cleanly-terminated COPY block
// (e.g. the "\." is not the final line), in which case the caller aborts
// rather than guessing.
function splitCopyChunk(statementText) {
  const lines = statementText.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^COPY\s+\S.*\bFROM\s+stdin;\s*$/i.test(line));
  const terminatorIndex = lines.findIndex((line) => line === "\\.");
  if (headerIndex === -1 || terminatorIndex === -1 || terminatorIndex <= headerIndex) return null;
  if (!lines.slice(terminatorIndex + 1).every((line) => line.trim() === "")) return null;
  return { header: lines[headerIndex], dataLines: lines.slice(headerIndex + 1, terminatorIndex) };
}

// PostgreSQL's wire protocol requires COPY data to arrive as separate
// CopyData sub-messages -- it cannot be appended as literal text after the
// COPY command in the same Query string (confirmed root cause of the retry5
// 42601 syntax error at the first data row). postgres.js's own COPY support
// is the streaming .writable() API (see its README "Copy to/from as
// Streams"), so the header alone is sent via sql.unsafe(header).writable()
// and the data lines are piped in afterward; the "\." terminator itself is
// never written -- ending the stream sends CopyDone, which is its protocol
// equivalent.
async function executeCopyChunk(sql, statementText) {
  const split = splitCopyChunk(statementText);
  if (!split) abort("ABORT_COPY_CHUNK_UNSPLITTABLE");
  const writable = await sql.unsafe(split.header).writable();
  const payload = split.dataLines.length > 0 ? split.dataLines.join("\n") + "\n" : "";
  await pipeline(Readable.from([payload]), writable);
}

async function executeStatement(sql, statementText) {
  if (isCopyChunk(statementText)) {
    await executeCopyChunk(sql, statementText);
  } else {
    await sql.unsafe(statementText).execute();
  }
}

// Evidence is always written from the actual observed value returned by this
// call, never from an assumed/self-authored constant -- callers pass the real
// query result or check outcome, not a hardcoded "ok".
function writeEvidence(name, payload) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const body = JSON.stringify({ timestampUtc: new Date().toISOString(), ...payload }, null, 2);
  writeFileSync(path.join(EVIDENCE_DIR, name), body, "utf8");
}

// Mirrors the PowerShell harness's Get-RedactedDiagnosticText: strips any
// line that mentions password/secret/token and any embedded URL credential.
// Applied to error.message only -- never to a raw SQL statement or query text.
function redactDiagnosticText(text) {
  if (text === null || text === undefined) return text;
  let redacted = String(text);
  redacted = redacted.replace(/^.*\b(password|secret|token)\b.*$/gim, "[REDACTED LINE - matched password/secret/token]");
  redacted = redacted.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:/\s]+):[^@/\s]+@/g, "$1:[REDACTED]@");
  return redacted;
}

// Only ever returns a plain non-negative integer or null -- never the
// original value verbatim, so a non-numeric surprise value cannot leak
// through this field.
function safeInteger(value) {
  if (value === undefined || value === null) return null;
  const asString = String(value);
  return /^\d+$/.test(asString) ? Number(asString) : null;
}

// Only ever returns a short identifier/basename-shaped string or null.
// PostgreSQL's routine/file fields are internal C source identifiers (e.g.
// "scanner_yyerror", "scan.l"), never user data or query content.
function safeIdentifier(value) {
  if (value === undefined || value === null) return null;
  const asString = String(value);
  return /^[A-Za-z0-9_.]+$/.test(asString) ? asString : null;
}

// Diagnostic-only evidence for a restore-stage failure, added because the
// prior blocker (retry3: ABORT_RESTORE_FAILURE with no supplemental detail)
// left no way to distinguish an unexpected-connection guard failure from an
// actual SQL failure, or to see the failing statement's SQLSTATE/type. Never
// stores the raw statement text or any SQL literal/value -- only a SHA-256
// identity and its leading keyword. Never stores query/detail/hint/where
// fields that some Postgres client errors populate with the statement text
// or data values themselves -- only position/routine/file/line, which are
// PostgreSQL-internal integers and C-source identifiers, never user data.
function writeRestoreFailureEvidence({ stage, statementCountBeforeFailure, statementText, error }) {
  const statementSha256 = statementText ? createHash("sha256").update(statementText).digest("hex").toUpperCase() : null;
  const statementTypeMatch = statementText ? statementText.match(/^\s*(\S+)/) : null;
  const statementType = statementTypeMatch ? statementTypeMatch[1].toUpperCase() : null;
  writeEvidence("04-restore-execution-failure.json", {
    stage,
    statementCountBeforeFailure,
    statementIndex: statementText ? statementCountBeforeFailure + 1 : null,
    statementSha256,
    statementType,
    errorName: error?.name ?? null,
    errorCode: error?.code ?? null,
    errorMessageRedacted: redactDiagnosticText(error?.message ?? String(error)),
    errorPosition: safeInteger(error?.position),
    errorRoutine: safeIdentifier(error?.routine),
    errorFile: error?.file ? safeIdentifier(path.basename(String(error.file))) : null,
    errorLine: safeInteger(error?.line),
    pass: false,
  });
}

async function verifySchema(sql, backupFile) {
  const checks = {};

  const missingCriticalTables = [];
  for (const table of CRITICAL_TABLES) {
    try {
      const [{ n }] = await sql.unsafe(
        "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
        [table],
      );
      if (Number(n) !== 1) missingCriticalTables.push(table);
    } catch {
      missingCriticalTables.push(table);
    }
  }
  checks.criticalTables = { expected: CRITICAL_TABLES, missing: missingCriticalTables, pass: missingCriticalTables.length === 0 };

  try {
    const [{ n }] = await sql.unsafe(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'",
    );
    if (Number(n) !== 1) {
      checks.drizzleMigrationsTable = { pass: false, reason: "table_missing" };
    } else {
      const [{ rowcount }] = await sql.unsafe('SELECT count(*)::int AS rowcount FROM drizzle."__drizzle_migrations"');
      checks.drizzleMigrationsTable = { rowCount: Number(rowcount), pass: Number(rowcount) > 0 };
    }
  } catch (error) {
    checks.drizzleMigrationsTable = { pass: false, error: "query_failed" };
  }

  const missingFunctions = [];
  for (const fn of EXPECTED_FUNCTIONS) {
    try {
      const [{ n }] = await sql.unsafe("SELECT count(*)::int AS n FROM pg_proc WHERE proname = $1", [fn]);
      if (Number(n) < 1) missingFunctions.push(fn);
    } catch {
      missingFunctions.push(fn);
    }
  }
  checks.functions = { expected: EXPECTED_FUNCTIONS, missing: missingFunctions, pass: missingFunctions.length === 0 };

  // Identity-level diff against the pinned backup's OWN DDL (never the
  // current migrations directory), so the schema gate's contract is exactly
  // "restored schema == pinned backup snapshot" rather than "restored schema
  // == whatever the live migrations directory currently expects". Any
  // extraction ambiguity fails both checks closed rather than silently
  // skipping the comparison.
  const expectedSchemaObjects = await extractExpectedSchemaObjects(backupFile);
  if (!expectedSchemaObjects) {
    checks.baseTableIdentity = { pass: false, reason: "BACKUP_SCHEMA_EXTRACTION_AMBIGUOUS" };
    checks.triggerIdentity = { pass: false, reason: "BACKUP_SCHEMA_EXTRACTION_AMBIGUOUS" };
  } else {
    try {
      const actualTableRows = await sql.unsafe(
        "SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema <> 'information_schema' AND table_schema NOT LIKE 'pg\\_%' ESCAPE '\\'",
      );
      const actualTables = actualTableRows.map((row) => `${row.table_schema}.${row.table_name}`);
      const actualTableSet = new Set(actualTables);
      const expectedTableSet = new Set(expectedSchemaObjects.tables);
      const missingTables = expectedSchemaObjects.tables.filter((t) => !actualTableSet.has(t));
      const unexpectedTables = actualTables.filter((t) => !expectedTableSet.has(t));
      checks.baseTableIdentity = {
        expectedBaseTableCount: expectedSchemaObjects.tables.length,
        actualBaseTableCount: actualTables.length,
        missingTables,
        unexpectedTables,
        pass: missingTables.length === 0 && unexpectedTables.length === 0,
      };
    } catch {
      checks.baseTableIdentity = { pass: false, reason: "actual_query_failed" };
    }

    try {
      const actualTriggerRows = await sql.unsafe("SELECT DISTINCT tgname FROM pg_trigger WHERE NOT tgisinternal");
      const actualTriggers = actualTriggerRows.map((row) => row.tgname);
      const actualTriggerSet = new Set(actualTriggers);
      const expectedTriggerSet = new Set(expectedSchemaObjects.triggers);
      const missingTriggerIdentities = expectedSchemaObjects.triggers.filter((t) => !actualTriggerSet.has(t));
      const unexpectedTriggers = actualTriggers.filter((t) => !expectedTriggerSet.has(t));
      checks.triggerIdentity = {
        expectedTriggers: expectedSchemaObjects.triggers,
        actualTriggers,
        missingTriggers: missingTriggerIdentities,
        unexpectedTriggers,
        pass: missingTriggerIdentities.length === 0 && unexpectedTriggers.length === 0,
      };
    } catch {
      checks.triggerIdentity = { pass: false, reason: "actual_query_failed" };
    }
  }

  const pass = Object.values(checks).every((c) => c.pass === true);
  writeEvidence("05-schema-inventory.json", { stage: "schema_verification", checks, pass });
  return pass;
}

async function verifyData(sql) {
  const tableCounts = {};
  for (const [table, expected] of Object.entries(EXPECTED_ROW_COUNTS)) {
    try {
      const [{ n }] = await sql.unsafe(`SELECT count(*)::bigint AS n FROM "${table}"`);
      const actual = Number(n);
      tableCounts[table] = { expected, actual, pass: actual === expected };
    } catch (error) {
      tableCounts[table] = { expected, actual: null, pass: false, error: "query_failed" };
    }
  }

  const orphanChecks = {};
  const companyScoped = ["agents", "projects", "goals", "issues", "approvals", "heartbeat_runs"];
  for (const table of companyScoped) {
    try {
      const [{ n }] = await sql.unsafe(
        `SELECT count(*)::bigint AS n FROM "${table}" t LEFT JOIN companies c ON c.id = t.company_id WHERE t.company_id IS NOT NULL AND c.id IS NULL`,
      );
      orphanChecks[table] = { orphanCount: Number(n), pass: Number(n) === 0 };
    } catch (error) {
      orphanChecks[table] = { orphanCount: null, pass: false, error: "query_failed" };
    }
  }
  try {
    const [{ n }] = await sql.unsafe(
      `SELECT count(*)::bigint AS n FROM heartbeat_run_events e LEFT JOIN heartbeat_runs r ON r.id = e.run_id WHERE r.id IS NULL`,
    );
    orphanChecks.heartbeat_run_events = { orphanCount: Number(n), pass: Number(n) === 0 };
  } catch (error) {
    orphanChecks.heartbeat_run_events = { orphanCount: null, pass: false, error: "query_failed" };
  }

  const pass = Object.values(tableCounts).every((c) => c.pass === true) && Object.values(orphanChecks).every((c) => c.pass === true);
  writeEvidence("06-table-counts-comparison.json", { stage: "data_verification", tableCounts, orphanChecks, pass });
  return pass;
}

async function verifyApprovalTtl(sql) {
  const checks = {};

  const missingColumns = [];
  for (const column of APPROVAL_TTL_COLUMNS) {
    try {
      const [{ n }] = await sql.unsafe(
        "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'approvals' AND column_name = $1",
        [column],
      );
      if (Number(n) !== 1) missingColumns.push(column);
    } catch {
      missingColumns.push(column);
    }
  }
  checks.columns = { expected: APPROVAL_TTL_COLUMNS, missing: missingColumns, pass: missingColumns.length === 0 };

  const missingIndexes = [];
  for (const index of APPROVAL_TTL_INDEXES) {
    try {
      const [{ n }] = await sql.unsafe("SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1", [index]);
      if (Number(n) !== 1) missingIndexes.push(index);
    } catch {
      missingIndexes.push(index);
    }
  }
  checks.indexes = { expected: APPROVAL_TTL_INDEXES, missing: missingIndexes, pass: missingIndexes.length === 0 };

  for (const table of ["issue_approvals", "approval_action_idempotency_keys"]) {
    try {
      const [{ n }] = await sql.unsafe(
        "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
        [table],
      );
      checks[table] = { pass: Number(n) === 1 };
    } catch {
      checks[table] = { pass: false, error: "query_failed" };
    }
  }

  try {
    const [{ n }] = await sql.unsafe(
      "SELECT count(*)::bigint AS n FROM approvals WHERE (consumed_at IS NULL) IS DISTINCT FROM (consumed_by_run_id IS NULL)",
    );
    checks.pairConsistency = { mismatchCount: Number(n), pass: Number(n) === 0 };
  } catch (error) {
    checks.pairConsistency = { mismatchCount: null, pass: false, error: "query_failed" };
  }

  try {
    const [{ n }] = await sql.unsafe("SELECT count(*)::bigint AS n FROM approvals WHERE superseded_by_approval_id = id");
    checks.noSelfReference = { selfReferenceCount: Number(n), pass: Number(n) === 0 };
  } catch (error) {
    checks.noSelfReference = { selfReferenceCount: null, pass: false, error: "query_failed" };
  }

  // Derived-expiry logic proof: confirms the same "pending AND expires_at <=
  // now" predicate the application uses to treat an approval as expired is
  // evaluable against the restored data, without asserting any particular
  // count (the pinned snapshot's own pending/expired mix is whatever it is).
  try {
    const [{ n }] = await sql.unsafe(
      "SELECT count(*)::bigint AS n FROM approvals WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= NOW()",
    );
    checks.derivedExpiryEvaluable = { expiredPendingCount: Number(n), pass: Number.isFinite(Number(n)) };
  } catch (error) {
    checks.derivedExpiryEvaluable = { expiredPendingCount: null, pass: false, error: "query_failed" };
  }

  const pass = Object.values(checks).every((c) => c.pass === true);
  writeEvidence("07-approval-ttl-audit.json", { stage: "approval_ttl_verification", checks, pass });
  return pass;
}

async function main() {
  const [backupFile, expectedDataDir, pidText, evidenceDir] = process.argv.slice(2);
  const expectedPostgresPid = Number(pidText);
  assertInputs(backupFile, expectedDataDir, expectedPostgresPid, evidenceDir);
  const password = readFileSync(0, "utf8").replace(/\r?\n$/, "");
  if (!password) abort("ABORT_EMPTY_PASSWORD");

  const connection = `postgres://${encodeURIComponent("nexora_restore_test")}:${encodeURIComponent(password)}@127.0.0.1:55432/postgres`;
  const parsed = new URL(connection);
  if (parsed.hostname !== "127.0.0.1" || parsed.port !== "55432" || parsed.pathname !== "/postgres" || parsed.username !== "nexora_restore_test") {
    abort("ABORT_CONNECTION_IDENTITY");
  }

  const sql = postgres(connection, { max: 1, connect_timeout: 5 });
  try {
    const iterator = readStatements(backupFile)[Symbol.asyncIterator]();

    // JIT bundle: every one of these six checks must complete, in order,
    // before the elapsed-time clock starts. The clock measures the gap from
    // "JIT bundle fully verified" to "first restore statement begins
    // executing" (not the duration of the checks themselves), per the
    // 1-second acceptance bound.
    const actualHash = createHash("sha256").update(readFileSync(backupFile)).digest("hex").toUpperCase();
    if (actualHash !== BACKUP_SHA256) abort("ABORT_JIT_BACKUP_HASH");
    assertEngineIsolation();
    await assertProtectedBaseline(tcpRows());

    const [identity] = await sql.unsafe("SELECT host(inet_server_addr()) AS server_addr, inet_server_port() AS server_port, current_database() AS database_name, current_user AS user_name, current_setting('data_directory') AS data_directory");
    const handshakeOk = !!identity && identity.server_addr === "127.0.0.1" && Number(identity.server_port) === 55432 &&
      identity.database_name === "postgres" && identity.user_name === "nexora_restore_test" &&
      canonical(String(identity.data_directory)) === canonical(PGDATA);
    writeEvidence("03-target-handshake.json", {
      stage: "target_handshake",
      observed: identity ?? null,
      expected: { server_addr: "127.0.0.1", server_port: 55432, database_name: "postgres", user_name: "nexora_restore_test", data_directory: PGDATA },
      pass: handshakeOk,
    });
    if (!handshakeOk) abort("ABORT_TARGET_HANDSHAKE");
    try {
      assertOnlyExpectedTargetConnection(tcpRows(), expectedPostgresPid);
    } catch (error) {
      writeRestoreFailureEvidence({ stage: "assert_expected_target_connection", statementCountBeforeFailure: 0, statementText: null, error });
      throw error;
    }

    // JIT bundle complete. Measure elapsed time to the actual restore start.
    const jitCompletedAt = performance.now();
    const first = await iterator.next();
    if (first.done || !first.value) abort("ABORT_EMPTY_RESTORE_STREAM");
    const jitElapsedMs = performance.now() - jitCompletedAt;
    if (jitElapsedMs > 1000) abort("ABORT_JIT_TIMEOUT");

    const restoreStartedAt = new Date().toISOString();
    let statementCount = 0;
    let currentStatementText = first.value;
    try {
      await executeStatement(sql, currentStatementText);
      statementCount++;
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        currentStatementText = next.value;
        await executeStatement(sql, currentStatementText);
        statementCount++;
      }
    } catch (error) {
      writeRestoreFailureEvidence({ stage: "restore_execution", statementCountBeforeFailure: statementCount, statementText: currentStatementText, error });
      throw error;
    }
    const restoreCompletedAt = new Date().toISOString();
    writeEvidence("04-restore-execution.log", {
      stage: "restore_execution",
      engineOrigin: ENGINE_ORIGIN,
      statementCount,
      sqlErrorCount: 0,
      startedAtUtc: restoreStartedAt,
      completedAtUtc: restoreCompletedAt,
      pass: true,
    });

    // Guard 16: the restore process reaching this point with zero thrown SQL
    // errors is necessary but not sufficient. Verification runs against the
    // disposable connection only and never touches 54329/54330.
    const schemaPass = await verifySchema(sql, backupFile);
    const dataPass = await verifyData(sql);
    const ttlPass = await verifyApprovalTtl(sql);
    const verdict = (schemaPass && dataPass && ttlPass) ? "VERIFIED_PASS" : "VERIFICATION_FAILED";

    process.stdout.write(JSON.stringify({
      engineOrigin: ENGINE_ORIGIN,
      statementCount,
      jitElapsedMs: Math.round(jitElapsedMs),
      guard16: { schemaPass, dataPass, ttlPass },
      verdict,
    }));
    if (verdict !== "VERIFIED_PASS") abort("ABORT_GUARD16_VERIFICATION_FAILED");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Only auto-run when this file is the actual process entry point (the normal
// `node nexora-backup-restore-js-engine.mjs <args>` invocation from the PS1
// harness). This is unchanged behavior for that real invocation -- it exists
// so a throwaway test script can safely `import` this module (to exercise
// verifySchema/verifyData/verifyApprovalTtl/writeEvidence against a mock
// `sql`) without main() executing for real as an import side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(error instanceof HarnessAbort ? error.code : "ABORT_JS_ENGINE_FAILURE");
    process.exitCode = 1;
  });
}

export { verifySchema, verifyData, verifyApprovalTtl, writeEvidence, EVIDENCE_DIR, EXPECTED_ROW_COUNTS, CRITICAL_TABLES, EXPECTED_FUNCTIONS, APPROVAL_TTL_COLUMNS, APPROVAL_TTL_INDEXES };
