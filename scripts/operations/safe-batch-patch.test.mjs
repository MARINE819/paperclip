import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe, beforeEach, afterEach } from "node:test";
import {
  computeSha256,
  executeBatchPatch,
  recoverFromJournal,
} from "./safe-batch-patch.mjs";

describe("safe-batch-patch", () => {
  let tempDir;
  let scratchDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sbp-test-"));
    scratchDir = join(tempDir, "scratch");
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  test("applies a valid 2-file batch patch successfully", () => {
    writeFileSync(join(tempDir, "fileA.txt"), "hello world", "utf8");
    writeFileSync(join(tempDir, "fileB.txt"), "foo bar baz", "utf8");

    const hashA = computeSha256("hello world");
    const hashB = computeSha256("foo bar baz");

    const manifest = {
      batchId: "batch-success-1",
      allowedFiles: ["fileA.txt", "fileB.txt"],
      operations: [
        {
          file: "fileA.txt",
          expectedSha256: hashA,
          replacements: [{ targetContent: "world", replacementContent: "nexora" }],
        },
        {
          file: "fileB.txt",
          expectedSha256: hashB,
          replacements: [{ targetContent: "bar", replacementContent: "qux" }],
        },
      ],
    };

    const res = executeBatchPatch(manifest, { repoRoot: tempDir, scratchDir });
    assert.equal(res.outcome, "success");
    assert.equal(readFileSync(join(tempDir, "fileA.txt"), "utf8"), "hello nexora");
    assert.equal(readFileSync(join(tempDir, "fileB.txt"), "utf8"), "foo qux baz");
  });

  test("fails closed on sha256_mismatch with 0 files modified", () => {
    writeFileSync(join(tempDir, "fileA.txt"), "hello world", "utf8");
    writeFileSync(join(tempDir, "fileB.txt"), "foo bar baz", "utf8");

    const manifest = {
      batchId: "batch-hash-mismatch",
      allowedFiles: ["fileA.txt", "fileB.txt"],
      operations: [
        {
          file: "fileA.txt",
          expectedSha256: "0000000000000000000000000000000000000000000000000000000000000000",
          replacements: [{ targetContent: "world", replacementContent: "nexora" }],
        },
      ],
    };

    assert.throws(
      () => executeBatchPatch(manifest, { repoRoot: tempDir, scratchDir }),
      /sha256_mismatch/,
    );
    assert.equal(readFileSync(join(tempDir, "fileA.txt"), "utf8"), "hello world");
    assert.equal(readFileSync(join(tempDir, "fileB.txt"), "utf8"), "foo bar baz");
  });

  test("fails closed on target_content_count_mismatch with 0 files modified", () => {
    writeFileSync(join(tempDir, "fileA.txt"), "hello world", "utf8");
    const hashA = computeSha256("hello world");

    const manifest = {
      batchId: "batch-target-mismatch",
      allowedFiles: ["fileA.txt"],
      operations: [
        {
          file: "fileA.txt",
          expectedSha256: hashA,
          replacements: [{ targetContent: "nonexistent", replacementContent: "nexora" }],
        },
      ],
    };

    assert.throws(
      () => executeBatchPatch(manifest, { repoRoot: tempDir, scratchDir }),
      /target_content_count_mismatch/,
    );
    assert.equal(readFileSync(join(tempDir, "fileA.txt"), "utf8"), "hello world");
  });

  test("blocks unauthorized files not in allowedFiles", () => {
    writeFileSync(join(tempDir, "fileA.txt"), "hello world", "utf8");
    const hashA = computeSha256("hello world");

    const manifest = {
      batchId: "batch-unauthorized",
      allowedFiles: ["fileB.txt"],
      operations: [
        {
          file: "fileA.txt",
          expectedSha256: hashA,
          replacements: [{ targetContent: "world", replacementContent: "nexora" }],
        },
      ],
    };

    assert.throws(
      () => executeBatchPatch(manifest, { repoRoot: tempDir, scratchDir }),
      /unauthorized_file/,
    );
  });

  test("blocks path traversal attempts", () => {
    const manifest = {
      batchId: "batch-traversal",
      allowedFiles: ["../outside.txt"],
      operations: [],
    };

    assert.throws(
      () => executeBatchPatch(manifest, { repoRoot: tempDir, scratchDir }),
      /path_traversal_forbidden/,
    );
  });

  test("blocks duplicate files in operations", () => {
    writeFileSync(join(tempDir, "fileA.txt"), "hello world", "utf8");
    const hashA = computeSha256("hello world");

    const manifest = {
      batchId: "batch-duplicate",
      allowedFiles: ["fileA.txt"],
      operations: [
        {
          file: "fileA.txt",
          expectedSha256: hashA,
          replacements: [{ targetContent: "world", replacementContent: "1" }],
        },
        {
          file: "fileA.txt",
          expectedSha256: hashA,
          replacements: [{ targetContent: "world", replacementContent: "2" }],
        },
      ],
    };

    assert.throws(
      () => executeBatchPatch(manifest, { repoRoot: tempDir, scratchDir }),
      /duplicate_file_in_manifest/,
    );
  });

  test("blocks malformed manifest", () => {
    assert.throws(
      () => executeBatchPatch(null, { repoRoot: tempDir, scratchDir }),
      /malformed_manifest/,
    );
    assert.throws(
      () => executeBatchPatch({ batchId: "" }, { repoRoot: tempDir, scratchDir }),
      /malformed_manifest/,
    );
  });

  test("executes compensating rollback of first file when second file mutation fails", () => {
    writeFileSync(join(tempDir, "fileA.txt"), "initial A", "utf8");
    writeFileSync(join(tempDir, "fileB.txt"), "initial B", "utf8");

    const hashA = computeSha256("initial A");
    const hashB = computeSha256("initial B");

    const manifest = {
      batchId: "batch-rollback-test",
      allowedFiles: ["fileA.txt", "fileB.txt"],
      operations: [
        {
          file: "fileA.txt",
          expectedSha256: hashA,
          replacements: [{ targetContent: "initial A", replacementContent: "modified A" }],
        },
        {
          file: "fileB.txt",
          expectedSha256: hashB,
          replacements: [{ targetContent: "initial B", replacementContent: "modified B" }],
        },
      ],
    };

    let fileAWasModifiedBeforeFailure = false;

    assert.throws(
      () =>
        executeBatchPatch(manifest, {
          repoRoot: tempDir,
          scratchDir,
          _testHooks: {
            beforeWriteFile: (file, index) => {
              if (index === 1) {
                const currentA = readFileSync(join(tempDir, "fileA.txt"), "utf8");
                if (currentA === "modified A") {
                  fileAWasModifiedBeforeFailure = true;
                }
                throw new Error("simulated_second_file_write_failure");
              }
            },
          },
        }),
      /batch_failed_and_rolled_back: simulated_second_file_write_failure/,
    );

    assert.equal(fileAWasModifiedBeforeFailure, true);
    assert.equal(readFileSync(join(tempDir, "fileA.txt"), "utf8"), "initial A");
    assert.equal(readFileSync(join(tempDir, "fileB.txt"), "utf8"), "initial B");

    const journalPath = join(scratchDir, "backups", "batch-rollback-test", "journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    assert.equal(journal.status, "rolled_back");
    assert.ok(journal.error.includes("simulated_second_file_write_failure"));
  });

  test("dry-run verifies preconditions without modifying files (0 files written)", () => {
    writeFileSync(join(tempDir, "fileA.txt"), "hello world", "utf8");
    const hashA = computeSha256("hello world");

    const manifest = {
      batchId: "batch-dry-run",
      allowedFiles: ["fileA.txt"],
      operations: [
        {
          file: "fileA.txt",
          expectedSha256: hashA,
          replacements: [{ targetContent: "world", replacementContent: "nexora" }],
        },
      ],
    };

    const res = executeBatchPatch(manifest, { repoRoot: tempDir, scratchDir, dryRun: true });
    assert.equal(res.outcome, "dry_run_success");
    assert.equal(res.modifiedFiles.length, 0);
    assert.equal(readFileSync(join(tempDir, "fileA.txt"), "utf8"), "hello world");
  });

  test("recovers from journal when batch was interrupted or crashed", () => {
    writeFileSync(join(tempDir, "fileA.txt"), "corrupted A", "utf8");

    const backupDir = join(scratchDir, "backups", "batch-interrupted");
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, "fileA.txt.orig"), "restored A", "utf8");
    writeFileSync(
      join(backupDir, "journal.json"),
      JSON.stringify({
        batchId: "batch-interrupted",
        status: "in_progress",
        repoRoot: tempDir,
        files: [{ file: "fileA.txt", backupFile: "fileA.txt.orig" }],
      }),
      "utf8",
    );

    const res = recoverFromJournal("batch-interrupted", { repoRoot: tempDir, scratchDir });
    assert.equal(res.outcome, "recovered");
    assert.equal(readFileSync(join(tempDir, "fileA.txt"), "utf8"), "restored A");
  });
});
