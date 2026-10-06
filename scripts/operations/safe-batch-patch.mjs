/**
 * NEXORA Safe Batch Mutation Runner
 *
 * Pattern: Fail-safe batch mutation with compensating rollback.
 *
 * Safety Model:
 * 1. Strict Allowlist: Only relative paths explicitly declared in allowedFiles are permitted.
 * 2. Preconditions: SHA-256 pre-check and exact target occurrence check across ALL files
 *    BEFORE any disk write is performed. Any mismatch causes 0-mutation abort.
 * 3. Compensating Rollback: Snapshots original files in-memory and to a persistent scratch journal
 *    before writing. If any sequential file write fails, all previously modified files are
 *    restored to their exact original bytes.
 * 4. Limitations: This is not an OS/filesystem transaction (e.g. NTFS TxF). An abrupt process kill
 *    (SIGKILL), OS crash, or power loss during physical disk flush cannot be rolled back by
 *    userland code. Persistent scratch journal enables subsequent manual or automated recovery
 *    via `--recover <batchId>`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, normalize, resolve } from "node:path";

export function computeSha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function validateRelativePath(relPath, repoRoot) {
  if (typeof relPath !== "string" || !relPath.trim()) {
    throw new Error("path_invalid: path must be a non-empty string");
  }
  if (isAbsolute(relPath)) {
    throw new Error(`path_must_be_relative: absolute paths are forbidden: ${relPath}`);
  }
  const normalized = normalize(relPath).replace(/\\/g, "/");
  if (normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    throw new Error(`path_traversal_forbidden: path traversal is forbidden: ${relPath}`);
  }
  const resolved = resolve(repoRoot, relPath);
  const resolvedRoot = resolve(repoRoot);
  if (!resolved.startsWith(resolvedRoot)) {
    throw new Error(`path_outside_repo: path is outside repository root: ${relPath}`);
  }
  return normalized;
}

export function validateManifest(manifest, repoRoot) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("malformed_manifest: manifest must be an object");
  }
  if (typeof manifest.batchId !== "string" || !manifest.batchId.trim()) {
    throw new Error("malformed_manifest: batchId must be a non-empty string");
  }
  if (!Array.isArray(manifest.allowedFiles) || manifest.allowedFiles.length === 0) {
    throw new Error("malformed_manifest: allowedFiles must be a non-empty array");
  }
  const normalizedAllowed = new Set();
  for (const f of manifest.allowedFiles) {
    const clean = validateRelativePath(f, repoRoot);
    if (normalizedAllowed.has(clean)) {
      throw new Error(`duplicate_file_in_manifest: allowedFiles contains duplicate: ${clean}`);
    }
    normalizedAllowed.add(clean);
  }

  if (!Array.isArray(manifest.operations) || manifest.operations.length === 0) {
    throw new Error("malformed_manifest: operations must be a non-empty array");
  }

  const seenOpFiles = new Set();
  const normalizedOperations = [];
  for (const op of manifest.operations) {
    if (!op || typeof op !== "object") {
      throw new Error("malformed_manifest: each operation must be an object");
    }
    const cleanFile = validateRelativePath(op.file, repoRoot);
    if (!normalizedAllowed.has(cleanFile)) {
      throw new Error(`unauthorized_file: file ${cleanFile} is not in allowedFiles`);
    }
    if (seenOpFiles.has(cleanFile)) {
      throw new Error(`duplicate_file_in_manifest: operations contains duplicate file: ${cleanFile}`);
    }
    seenOpFiles.add(cleanFile);

    if (typeof op.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(op.expectedSha256.trim())) {
      throw new Error(`malformed_manifest: expectedSha256 must be a 64-char hex string for ${cleanFile}`);
    }

    if (!Array.isArray(op.replacements) || op.replacements.length === 0) {
      throw new Error(`malformed_manifest: replacements must be a non-empty array for ${cleanFile}`);
    }

    const replacements = [];
    for (const r of op.replacements) {
      if (!r || typeof r !== "object") {
        throw new Error(`malformed_manifest: replacement must be an object in ${cleanFile}`);
      }
      if (typeof r.targetContent !== "string" || r.targetContent.length === 0) {
        throw new Error(`malformed_manifest: targetContent must be a non-empty string in ${cleanFile}`);
      }
      if (typeof r.replacementContent !== "string") {
        throw new Error(`malformed_manifest: replacementContent must be a string in ${cleanFile}`);
      }
      const expectedOccurrences = r.expectedOccurrences !== undefined ? Number(r.expectedOccurrences) : 1;
      if (!Number.isInteger(expectedOccurrences) || expectedOccurrences < 1) {
        throw new Error(`malformed_manifest: expectedOccurrences must be a positive integer in ${cleanFile}`);
      }
      replacements.push({
        targetContent: r.targetContent,
        replacementContent: r.replacementContent,
        expectedOccurrences,
      });
    }

    normalizedOperations.push({
      file: cleanFile,
      expectedSha256: op.expectedSha256.trim().toLowerCase(),
      replacements,
    });
  }

  return {
    batchId: manifest.batchId.trim(),
    description: manifest.description,
    allowedFiles: Array.from(normalizedAllowed),
    operations: normalizedOperations,
  };
}

export function executeBatchPatch(rawManifest, options = {}) {
  const repoRoot = options.repoRoot ? resolve(options.repoRoot) : process.cwd();
  const scratchDir = options.scratchDir
    ? resolve(options.scratchDir)
    : resolve(repoRoot, "scratch");
  const dryRun = Boolean(options.dryRun);
  const testHooks = options._testHooks || {};

  const manifest = validateManifest(rawManifest, repoRoot);

  // 1. PRECONDITION CHECK
  const originalContents = new Map();
  const simulatedContents = new Map();

  for (const op of manifest.operations) {
    const fullPath = resolve(repoRoot, op.file);
    if (!existsSync(fullPath)) {
      throw new Error(`file_not_found: target file does not exist: ${op.file}`);
    }

    const currentContent = readFileSync(fullPath, "utf8");
    const currentHash = computeSha256(currentContent);
    if (currentHash !== op.expectedSha256) {
      throw new Error(
        `sha256_mismatch: file ${op.file} expected ${op.expectedSha256} but found ${currentHash}`,
      );
    }

    originalContents.set(op.file, currentContent);

    let contentToUpdate = currentContent;
    for (const r of op.replacements) {
      const parts = contentToUpdate.split(r.targetContent);
      const actualOccurrences = parts.length - 1;
      if (actualOccurrences !== r.expectedOccurrences) {
        throw new Error(
          `target_content_count_mismatch: file ${op.file} expected ${r.expectedOccurrences} occurrences but found ${actualOccurrences}`,
        );
      }
      contentToUpdate = parts.join(r.replacementContent);
    }

    simulatedContents.set(op.file, contentToUpdate);
  }

  // 2. DRY-RUN EXIT
  if (dryRun) {
    return {
      outcome: "dry_run_success",
      batchId: manifest.batchId,
      modifiedFiles: [],
      plannedFiles: manifest.operations.map((op) => op.file),
    };
  }

  // 3. PERSISTENT JOURNAL & BACKUP BEFORE MUTATION
  const backupDir = resolve(scratchDir, "backups", manifest.batchId);
  mkdirSync(backupDir, { recursive: true });

  const journalFiles = [];
  for (const op of manifest.operations) {
    const safeBackupName = op.file.replace(/[^a-zA-Z0-9._-]/g, "_") + ".orig";
    const backupPath = resolve(backupDir, safeBackupName);
    writeFileSync(backupPath, originalContents.get(op.file), "utf8");

    journalFiles.push({
      file: op.file,
      backupFile: safeBackupName,
      originalSha256: op.expectedSha256,
      newSha256: computeSha256(simulatedContents.get(op.file)),
    });
  }

  const journal = {
    batchId: manifest.batchId,
    status: "in_progress",
    startTime: new Date().toISOString(),
    repoRoot,
    files: journalFiles,
  };
  const journalPath = resolve(backupDir, "journal.json");
  writeFileSync(journalPath, JSON.stringify(journal, null, 2), "utf8");

  // 4. MUTATION PHASE WITH COMPENSATING ROLLBACK
  const modifiedFiles = [];
  try {
    for (let i = 0; i < manifest.operations.length; i++) {
      const op = manifest.operations[i];

      if (typeof testHooks.beforeWriteFile === "function") {
        testHooks.beforeWriteFile(op.file, i);
      }

      const fullPath = resolve(repoRoot, op.file);
      const newContent = simulatedContents.get(op.file);
      writeFileSync(fullPath, newContent, "utf8");
      modifiedFiles.push(op.file);

      if (typeof testHooks.afterWriteFile === "function") {
        testHooks.afterWriteFile(op.file, i);
      }
    }

    // 5. POSTCONDITION CHECK
    for (const op of manifest.operations) {
      const fullPath = resolve(repoRoot, op.file);
      const writtenContent = readFileSync(fullPath, "utf8");
      const writtenHash = computeSha256(writtenContent);
      const expectedNewHash = computeSha256(simulatedContents.get(op.file));
      if (writtenHash !== expectedNewHash) {
        throw new Error(
          `postcondition_failed: written content hash mismatch for ${op.file}`,
        );
      }
    }

    journal.status = "completed";
    journal.completedTime = new Date().toISOString();
    writeFileSync(journalPath, JSON.stringify(journal, null, 2), "utf8");

    return {
      outcome: "success",
      batchId: manifest.batchId,
      modifiedFiles,
      journalPath,
    };
  } catch (err) {
    // COMPENSATING ROLLBACK
    for (const file of modifiedFiles) {
      try {
        const fullPath = resolve(repoRoot, file);
        const originalContent = originalContents.get(file);
        if (originalContent !== undefined) {
          writeFileSync(fullPath, originalContent, "utf8");
        }
      } catch (rollbackErr) {
        console.error(`Compensating rollback error on ${file}:`, rollbackErr);
      }
    }

    journal.status = "rolled_back";
    journal.error = err.message;
    journal.rolledBackTime = new Date().toISOString();
    try {
      writeFileSync(journalPath, JSON.stringify(journal, null, 2), "utf8");
    } catch {}

    throw new Error(`batch_failed_and_rolled_back: ${err.message}`);
  }
}

export function recoverFromJournal(journalPathOrBatchId, options = {}) {
  const repoRoot = options.repoRoot ? resolve(options.repoRoot) : process.cwd();
  const scratchDir = options.scratchDir
    ? resolve(options.scratchDir)
    : resolve(repoRoot, "scratch");

  let journalPath = journalPathOrBatchId;
  if (!existsSync(journalPath)) {
    journalPath = resolve(scratchDir, "backups", journalPathOrBatchId, "journal.json");
    if (!existsSync(journalPath)) {
      throw new Error(`journal_not_found: cannot locate journal for ${journalPathOrBatchId}`);
    }
  }

  const journalDir = dirname(journalPath);
  const journalContent = JSON.parse(readFileSync(journalPath, "utf8"));
  if (journalContent.status === "completed") {
    return { outcome: "already_completed", batchId: journalContent.batchId, restoredFiles: [] };
  }

  const restoredFiles = [];
  for (const item of journalContent.files) {
    const targetPath = resolve(repoRoot, item.file);
    const backupFilePath = resolve(journalDir, item.backupFile);
    if (!existsSync(backupFilePath)) {
      throw new Error(`backup_file_missing: cannot restore ${item.file}, backup file ${item.backupFile} missing`);
    }
    const backupContent = readFileSync(backupFilePath, "utf8");
    writeFileSync(targetPath, backupContent, "utf8");
    restoredFiles.push(item.file);
  }

  journalContent.status = "recovered";
  journalContent.recoveredTime = new Date().toISOString();
  writeFileSync(journalPath, JSON.stringify(journalContent, null, 2), "utf8");

  return { outcome: "recovered", batchId: journalContent.batchId, restoredFiles };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/operations/safe-batch-patch.mjs")) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const recoverIndex = args.indexOf("--recover");
  if (recoverIndex !== -1 && args[recoverIndex + 1]) {
    const res = recoverFromJournal(args[recoverIndex + 1]);
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  }
  const manifestArg = args.find((a) => !a.startsWith("--"));
  if (!manifestArg) {
    console.error("Usage: node safe-batch-patch.mjs <manifest.json> [--dry-run] [--recover <batchId>]");
    process.exit(1);
  }
  const manifestRaw = JSON.parse(readFileSync(manifestArg, "utf8"));
  const result = executeBatchPatch(manifestRaw, { dryRun });
  console.log(JSON.stringify(result, null, 2));
}
