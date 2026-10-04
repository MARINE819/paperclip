import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ALLOWED_BRANCH,
  ALLOWED_REMOTES,
  VERIFY_PROFILES,
  buildDryRunDiffPreview,
  buildIsolatedApprovedPreview,
  checkHookAndFilterPolicy,
  checkPushTargetSafety,
  checkRemoteFastForwardSafety,
  classifyPushOutcome,
  diffPathSets,
  isSafeApprovedPath,
  parseArgs,
  readLiveRemoteHead,
  validateApprovedPathOnDisk,
  validateManifest,
} from "./git-save.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./git-save.mjs", import.meta.url));

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function initThrowawayRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "git-save-fixture-"));
  git(["init", "--initial-branch=master"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(path.join(dir, "tracked.txt"), "original\n", "utf8");
  git(["add", "tracked.txt"], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

/** A local-filesystem "remote" bare repo, pushed to once, with a real origin remote-tracking ref -- no network involved. */
function initThrowawayRepoWithRemote() {
  const localDir = initThrowawayRepo();
  const remoteDir = mkdtempSync(path.join(os.tmpdir(), "git-save-remote-"));
  git(["init", "--bare", "--initial-branch=master"], remoteDir);
  git(["remote", "add", "origin", remoteDir], localDir);
  git(["push", "origin", "master"], localDir);
  git(["fetch", "origin"], localDir); // test-fixture setup only, not the script under test
  const head = git(["rev-parse", "HEAD"], localDir);
  return { localDir, remoteDir, head };
}

function cleanupDirs(...dirs) {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

function validManifest(repoRoot, overrides = {}) {
  const head = git(["rev-parse", "HEAD"], repoRoot);
  const remoteHead = git(["rev-parse", "origin/master"], repoRoot);
  return {
    version: 1,
    expectedRepoRoot: repoRoot,
    expectedRemoteUrl: git(["remote", "get-url", "origin"], repoRoot),
    remote: "origin",
    branch: "master",
    expectedHeadBefore: head,
    expectedRemoteHeadBefore: remoteHead,
    approvedPaths: ["new-file.txt"],
    verifyProfile: "git-save-self-test",
    commitMessage: "test commit",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isSafeApprovedPath
// ---------------------------------------------------------------------------

test("isSafeApprovedPath rejects globs, absolute paths, traversal, '.', and pathspec magic", () => {
  const root = "C:/fake/repo";
  assert.equal(isSafeApprovedPath(root, "src/*.ts"), false);
  assert.equal(isSafeApprovedPath(root, "C:/fake/repo/src/index.ts"), false);
  assert.equal(isSafeApprovedPath(root, "../outside.txt"), false);
  assert.equal(isSafeApprovedPath(root, "."), false);
  assert.equal(isSafeApprovedPath(root, root), false);
  assert.equal(isSafeApprovedPath(root, ":(top)src/index.ts"), false);
  assert.equal(isSafeApprovedPath(root, ""), false);
  assert.equal(isSafeApprovedPath(root, "src/index.ts"), true);
});

// ---------------------------------------------------------------------------
// validateApprovedPathOnDisk
// ---------------------------------------------------------------------------

test("validateApprovedPathOnDisk: missing file is allowed (tracked-deletion case)", () => {
  const dir = initThrowawayRepo();
  try {
    const result = validateApprovedPathOnDisk(dir, "does-not-exist.txt");
    assert.equal(result.ok, true);
    assert.equal(result.missing, true);
  } finally {
    cleanupDirs(dir);
  }
});

test("validateApprovedPathOnDisk: rejects a directory", () => {
  const dir = initThrowawayRepo();
  try {
    mkdirSync(path.join(dir, "subdir"));
    const result = validateApprovedPathOnDisk(dir, "subdir");
    assert.equal(result.ok, false);
    assert.match(result.reason, /directory/);
  } finally {
    cleanupDirs(dir);
  }
});

test("validateApprovedPathOnDisk: rejects a symlink (skips if the platform denies symlink creation)", (t) => {
  const dir = initThrowawayRepo();
  try {
    const linkPath = path.join(dir, "link.txt");
    try {
      symlinkSync(path.join(dir, "tracked.txt"), linkPath, "file");
    } catch (err) {
      t.skip(`no symlink privilege available on this platform/account: ${err.message}`);
      return;
    }
    const result = validateApprovedPathOnDisk(dir, "link.txt");
    assert.equal(result.ok, false);
    assert.match(result.reason, /symlink/);
  } finally {
    cleanupDirs(dir);
  }
});

// ---------------------------------------------------------------------------
// validateManifest
// ---------------------------------------------------------------------------

test("validateManifest: accepts a well-formed manifest", () => {
  const { localDir, remoteDir } = initThrowawayRepoWithRemote();
  try {
    const errors = validateManifest(validManifest(localDir), { repoRoot: localDir });
    assert.deepEqual(errors, []);
  } finally {
    cleanupDirs(localDir, remoteDir);
  }
});

test("validateManifest: rejects remote outside allowlist", () => {
  const { localDir, remoteDir } = initThrowawayRepoWithRemote();
  try {
    const errors = validateManifest(validManifest(localDir, { remote: "upstream" }), { repoRoot: localDir });
    assert.ok(errors.some((e) => e.includes("manifest.remote")));
  } finally {
    cleanupDirs(localDir, remoteDir);
  }
});

test("validateManifest: rejects branch !== master", () => {
  const { localDir, remoteDir } = initThrowawayRepoWithRemote();
  try {
    const errors = validateManifest(validManifest(localDir, { branch: "main" }), { repoRoot: localDir });
    assert.ok(errors.some((e) => e.includes("manifest.branch")));
  } finally {
    cleanupDirs(localDir, remoteDir);
  }
});

test("validateManifest: rejects empty approvedPaths", () => {
  const { localDir, remoteDir } = initThrowawayRepoWithRemote();
  try {
    const errors = validateManifest(validManifest(localDir, { approvedPaths: [] }), { repoRoot: localDir });
    assert.ok(errors.some((e) => e.includes("approvedPaths")));
  } finally {
    cleanupDirs(localDir, remoteDir);
  }
});

test("validateManifest: rejects exact-string duplicate approvedPaths", () => {
  const { localDir, remoteDir } = initThrowawayRepoWithRemote();
  try {
    const errors = validateManifest(
      validManifest(localDir, { approvedPaths: ["a.txt", "a.txt"] }),
      { repoRoot: localDir },
    );
    assert.ok(errors.some((e) => e.includes("duplicate")));
  } finally {
    cleanupDirs(localDir, remoteDir);
  }
});

test("validateManifest: rejects normalized/case-insensitive duplicate approvedPaths", () => {
  const { localDir, remoteDir } = initThrowawayRepoWithRemote();
  try {
    const errors = validateManifest(
      validManifest(localDir, { approvedPaths: ["src/Foo.ts", "src/foo.ts"] }),
      { repoRoot: localDir },
    );
    assert.ok(errors.some((e) => e.includes("duplicate")));
  } finally {
    cleanupDirs(localDir, remoteDir);
  }
});

test("validateManifest: rejects unsafe approvedPaths entries", () => {
  const { localDir, remoteDir } = initThrowawayRepoWithRemote();
  try {
    const errors = validateManifest(
      validManifest(localDir, { approvedPaths: ["../escape.txt"] }),
      { repoRoot: localDir },
    );
    assert.ok(errors.some((e) => e.includes("approvedPaths")));
  } finally {
    cleanupDirs(localDir, remoteDir);
  }
});

test("validateManifest: rejects an unknown verifyProfile", () => {
  const { localDir, remoteDir } = initThrowawayRepoWithRemote();
  try {
    const errors = validateManifest(validManifest(localDir, { verifyProfile: "whatever-i-want" }), { repoRoot: localDir });
    assert.ok(errors.some((e) => e.includes("verifyProfile")));
  } finally {
    cleanupDirs(localDir, remoteDir);
  }
});

test("validateManifest: a supplied verifyCommands field has no effect -- verifyProfile is still required", () => {
  const { localDir, remoteDir } = initThrowawayRepoWithRemote();
  try {
    const manifest = validManifest(localDir);
    delete manifest.verifyProfile;
    manifest.verifyCommands = [{ cwd: ".", command: "node", args: ["-e", "throw new Error('should never run')"] }];
    const errors = validateManifest(manifest, { repoRoot: localDir });
    assert.ok(errors.some((e) => e.includes("verifyProfile")));
  } finally {
    cleanupDirs(localDir, remoteDir);
  }
});

test("validateManifest: rejects a mismatched expectedRepoRoot", () => {
  const { localDir, remoteDir } = initThrowawayRepoWithRemote();
  try {
    const errors = validateManifest(validManifest(localDir, { expectedRepoRoot: "C:/some/other/repo" }), { repoRoot: localDir });
    assert.ok(errors.some((e) => e.includes("expectedRepoRoot")));
  } finally {
    cleanupDirs(localDir, remoteDir);
  }
});

test("validateManifest: rejects a missing expectedHeadBefore", () => {
  const { localDir, remoteDir } = initThrowawayRepoWithRemote();
  try {
    const manifest = validManifest(localDir);
    delete manifest.expectedHeadBefore;
    const errors = validateManifest(manifest, { repoRoot: localDir });
    assert.ok(errors.some((e) => e.includes("expectedHeadBefore")));
  } finally {
    cleanupDirs(localDir, remoteDir);
  }
});

test("validateManifest: rejects an abbreviated (short) expectedHeadBefore", () => {
  const { localDir, remoteDir } = initThrowawayRepoWithRemote();
  try {
    const errors = validateManifest(validManifest(localDir, { expectedHeadBefore: "abc1234" }), { repoRoot: localDir });
    assert.ok(errors.some((e) => e.includes("expectedHeadBefore")));
  } finally {
    cleanupDirs(localDir, remoteDir);
  }
});

test("validateManifest: rejects a missing expectedRemoteHeadBefore", () => {
  const { localDir, remoteDir } = initThrowawayRepoWithRemote();
  try {
    const manifest = validManifest(localDir);
    delete manifest.expectedRemoteHeadBefore;
    const errors = validateManifest(manifest, { repoRoot: localDir });
    assert.ok(errors.some((e) => e.includes("expectedRemoteHeadBefore")));
  } finally {
    cleanupDirs(localDir, remoteDir);
  }
});

test("validateManifest: rejects an abbreviated (short) expectedRemoteHeadBefore", () => {
  const { localDir, remoteDir } = initThrowawayRepoWithRemote();
  try {
    const errors = validateManifest(validManifest(localDir, { expectedRemoteHeadBefore: "abc1234" }), { repoRoot: localDir });
    assert.ok(errors.some((e) => e.includes("expectedRemoteHeadBefore")));
  } finally {
    cleanupDirs(localDir, remoteDir);
  }
});

// ---------------------------------------------------------------------------
// diffPathSets
// ---------------------------------------------------------------------------

test("diffPathSets: detects missing and extra entries", () => {
  const { missing, extra } = diffPathSets(["a.txt", "b.txt"], ["b.txt", "c.txt"]);
  assert.deepEqual(missing, ["a.txt"]);
  assert.deepEqual(extra, ["c.txt"]);
});

test("diffPathSets: reports none for identical sets", () => {
  const { missing, extra } = diffPathSets(["a.txt"], ["a.txt"]);
  assert.deepEqual(missing, []);
  assert.deepEqual(extra, []);
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test("parseArgs: reads --manifest and --dry-run", () => {
  const result = parseArgs(["--manifest", "foo.json", "--dry-run"]);
  assert.equal(result.manifestPath, "foo.json");
  assert.equal(result.dryRun, true);
});

test("parseArgs: rejects unknown flags", () => {
  assert.throws(() => parseArgs(["--bogus"]));
});

// ---------------------------------------------------------------------------
// buildIsolatedApprovedPreview / buildDryRunDiffPreview -- true non-mutating dry-run
// ---------------------------------------------------------------------------

test("buildDryRunDiffPreview: previews an untracked new file without touching the real index/HEAD/objects", () => {
  const dir = initThrowawayRepo();
  try {
    writeFileSync(path.join(dir, "new-file.txt"), "hello\n", "utf8");

    const realIndexBefore = readFileSync(path.join(dir, ".git", "index"));
    const realHeadBefore = git(["rev-parse", "HEAD"], dir);
    const realObjectsBefore = execFileSync("git", ["count-objects", "-v"], { cwd: dir, encoding: "utf8" });

    const diff = buildDryRunDiffPreview(dir, ["new-file.txt"]);
    assert.match(diff, /new-file\.txt/);
    assert.match(diff, /hello/);

    const realIndexAfter = readFileSync(path.join(dir, ".git", "index"));
    const realHeadAfter = git(["rev-parse", "HEAD"], dir);
    const realObjectsAfter = execFileSync("git", ["count-objects", "-v"], { cwd: dir, encoding: "utf8" });

    assert.ok(realIndexBefore.equals(realIndexAfter), "real .git/index must be byte-identical");
    assert.equal(realHeadBefore, realHeadAfter, "real HEAD must not move");
    assert.equal(realObjectsBefore, realObjectsAfter, "real .git/objects count must not change");
    assert.match(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }), /\?\? new-file\.txt/);
  } finally {
    cleanupDirs(dir);
  }
});

test("buildDryRunDiffPreview: previews a tracked modified file without touching the real index/HEAD/objects", () => {
  const dir = initThrowawayRepo();
  try {
    writeFileSync(path.join(dir, "tracked.txt"), "modified\n", "utf8");

    const realIndexBefore = readFileSync(path.join(dir, ".git", "index"));
    const realHeadBefore = git(["rev-parse", "HEAD"], dir);
    const realObjectsBefore = execFileSync("git", ["count-objects", "-v"], { cwd: dir, encoding: "utf8" });

    const diff = buildDryRunDiffPreview(dir, ["tracked.txt"]);
    assert.match(diff, /-original/);
    assert.match(diff, /\+modified/);

    const realIndexAfter = readFileSync(path.join(dir, ".git", "index"));
    const realHeadAfter = git(["rev-parse", "HEAD"], dir);
    const realObjectsAfter = execFileSync("git", ["count-objects", "-v"], { cwd: dir, encoding: "utf8" });

    assert.ok(realIndexBefore.equals(realIndexAfter), "real .git/index must be byte-identical");
    assert.equal(realHeadBefore, realHeadAfter, "real HEAD must not move");
    assert.equal(realObjectsBefore, realObjectsAfter, "real .git/objects count must not change (object-store isolation)");
  } finally {
    cleanupDirs(dir);
  }
});

test("buildIsolatedApprovedPreview: returns a tree OID matching a real git add + write-tree of the same content", () => {
  const dir = initThrowawayRepo();
  try {
    writeFileSync(path.join(dir, "new-file.txt"), "hello\n", "utf8");
    const { treeOid } = buildIsolatedApprovedPreview(dir, ["new-file.txt"]);

    git(["add", "new-file.txt"], dir);
    const realTreeOid = git(["write-tree"], dir);

    assert.equal(treeOid, realTreeOid);
  } finally {
    cleanupDirs(dir);
  }
});

test("buildIsolatedApprovedPreview: detects a tree-OID mismatch when the working tree changes between two computations (TOCTOU detection proof)", () => {
  const dir = initThrowawayRepo();
  try {
    writeFileSync(path.join(dir, "new-file.txt"), "version-1\n", "utf8");
    const first = buildIsolatedApprovedPreview(dir, ["new-file.txt"]);

    writeFileSync(path.join(dir, "new-file.txt"), "version-2\n", "utf8");
    const second = buildIsolatedApprovedPreview(dir, ["new-file.txt"]);

    assert.notEqual(first.treeOid, second.treeOid, "the scope gate's tree-OID consistency check must be able to detect this exact kind of drift");
  } finally {
    cleanupDirs(dir);
  }
});

test("buildIsolatedApprovedPreview: handles Windows CRLF content correctly", () => {
  const dir = initThrowawayRepo();
  try {
    writeFileSync(path.join(dir, "crlf-file.txt"), "line one\r\nline two\r\n", "utf8");
    const { diff, treeOid } = buildIsolatedApprovedPreview(dir, ["crlf-file.txt"]);
    assert.match(diff, /crlf-file\.txt/);
    assert.match(diff, /line one/);
    assert.ok(/^[0-9a-f]{40}$/.test(treeOid));
  } finally {
    cleanupDirs(dir);
  }
});

test("buildIsolatedApprovedPreview: handles a non-ASCII (Korean) filename correctly", () => {
  const dir = initThrowawayRepo();
  try {
    const filename = "한글-파일.txt";
    writeFileSync(path.join(dir, filename), "내용\n", "utf8");
    const { diff } = buildIsolatedApprovedPreview(dir, [filename]);
    assert.ok(diff.includes(filename), "diff output should contain the unquoted unicode filename");
  } finally {
    cleanupDirs(dir);
  }
});

// ---------------------------------------------------------------------------
// checkRemoteFastForwardSafety
// ---------------------------------------------------------------------------

test("checkRemoteFastForwardSafety: passes when the remote-tracking ref is an ancestor of HEAD", () => {
  const dir = initThrowawayRepo();
  try {
    const head = git(["rev-parse", "HEAD"], dir);
    execFileSync("git", ["update-ref", "refs/remotes/origin/master", head], { cwd: dir, stdio: "pipe" });
    const result = checkRemoteFastForwardSafety({ repoRoot: dir, remote: "origin", branch: "master", expectedRemoteHeadBefore: head });
    assert.equal(result.ok, true);
  } finally {
    cleanupDirs(dir);
  }
});

test("checkRemoteFastForwardSafety: fails closed when local HEAD and the remote-tracking ref have diverged", () => {
  const dir = initThrowawayRepo();
  try {
    const head = git(["rev-parse", "HEAD"], dir);
    const baseTree = git(["write-tree"], dir);
    const divergedCommit = execFileSync(
      "git",
      ["commit-tree", baseTree, "-p", head, "-m", "diverged remote commit"],
      { cwd: dir, encoding: "utf8" },
    ).trim();
    execFileSync("git", ["update-ref", "refs/remotes/origin/master", divergedCommit], { cwd: dir, stdio: "pipe" });
    writeFileSync(path.join(dir, "local-only.txt"), "local\n", "utf8");
    git(["add", "local-only.txt"], dir);
    git(["commit", "-m", "local-only commit"], dir);

    const result = checkRemoteFastForwardSafety({ repoRoot: dir, remote: "origin", branch: "master", expectedRemoteHeadBefore: divergedCommit });
    assert.equal(result.ok, false);
    assert.match(result.reason, /diverged/);
  } finally {
    cleanupDirs(dir);
  }
});

test("checkRemoteFastForwardSafety: fails when expectedRemoteHeadBefore does not match the locally-known remote ref", () => {
  const dir = initThrowawayRepo();
  try {
    const head = git(["rev-parse", "HEAD"], dir);
    execFileSync("git", ["update-ref", "refs/remotes/origin/master", head], { cwd: dir, stdio: "pipe" });
    const result = checkRemoteFastForwardSafety({ repoRoot: dir, remote: "origin", branch: "master", expectedRemoteHeadBefore: "0".repeat(40) });
    assert.equal(result.ok, false);
    assert.match(result.reason, /expectedRemoteHeadBefore/);
  } finally {
    cleanupDirs(dir);
  }
});

test("checkRemoteFastForwardSafety: fails when there is no local record of the remote-tracking ref", () => {
  const dir = initThrowawayRepo();
  try {
    const result = checkRemoteFastForwardSafety({ repoRoot: dir, remote: "origin", branch: "master", expectedRemoteHeadBefore: "0".repeat(40) });
    assert.equal(result.ok, false);
    assert.match(result.reason, /no local record/);
  } finally {
    cleanupDirs(dir);
  }
});

// ---------------------------------------------------------------------------
// readLiveRemoteHead
// ---------------------------------------------------------------------------

test("readLiveRemoteHead: reads an exact match from a real (local-filesystem) remote", () => {
  const { localDir, remoteDir, head } = initThrowawayRepoWithRemote();
  try {
    const result = readLiveRemoteHead(localDir, remoteDir, "master");
    assert.equal(result.ok, true);
    assert.equal(result.sha, head);
  } finally {
    cleanupDirs(localDir, remoteDir);
  }
});

test("readLiveRemoteHead: fails closed when the branch does not exist on the remote", () => {
  const { localDir, remoteDir } = initThrowawayRepoWithRemote();
  const emptyRemote = mkdtempSync(path.join(os.tmpdir(), "git-save-empty-remote-"));
  try {
    git(["init", "--bare", "--initial-branch=master"], emptyRemote);
    const result = readLiveRemoteHead(localDir, emptyRemote, "master");
    assert.equal(result.ok, false);
  } finally {
    cleanupDirs(localDir, remoteDir, emptyRemote);
  }
});

// ---------------------------------------------------------------------------
// checkPushTargetSafety
// ---------------------------------------------------------------------------

function initRepoWithOrigin(url) {
  const dir = initThrowawayRepo();
  git(["remote", "add", "origin", url], dir);
  return dir;
}

test("checkPushTargetSafety: passes for a clean single-fetch-single-push-URL remote", () => {
  const dir = initRepoWithOrigin("https://example.invalid/fake/repo.git");
  try {
    const result = checkPushTargetSafety({ repoRoot: dir, remote: "origin", expectedRemoteUrl: "https://example.invalid/fake/repo.git" });
    assert.equal(result.ok, true);
  } finally {
    cleanupDirs(dir);
  }
});

test("checkPushTargetSafety: fails when the push URL does not match expectedRemoteUrl", () => {
  const dir = initRepoWithOrigin("https://example.invalid/fake/repo.git");
  try {
    git(["remote", "set-url", "--push", "origin", "https://example.invalid/different/repo.git"], dir);
    const result = checkPushTargetSafety({ repoRoot: dir, remote: "origin", expectedRemoteUrl: "https://example.invalid/fake/repo.git" });
    assert.equal(result.ok, false);
    assert.match(result.reason, /push URL/);
  } finally {
    cleanupDirs(dir);
  }
});

test("checkPushTargetSafety: fails when there is more than one push URL configured", () => {
  const dir = initRepoWithOrigin("https://example.invalid/fake/repo.git");
  try {
    git(["remote", "set-url", "--add", "--push", "origin", "https://example.invalid/second/repo.git"], dir);
    const result = checkPushTargetSafety({ repoRoot: dir, remote: "origin", expectedRemoteUrl: "https://example.invalid/fake/repo.git" });
    assert.equal(result.ok, false);
    assert.match(result.reason, /push URL/);
  } finally {
    cleanupDirs(dir);
  }
});

test("checkPushTargetSafety: fails closed when remote.origin.mirror is set", () => {
  const dir = initRepoWithOrigin("https://example.invalid/fake/repo.git");
  try {
    git(["config", "remote.origin.mirror", "true"], dir);
    const result = checkPushTargetSafety({ repoRoot: dir, remote: "origin", expectedRemoteUrl: "https://example.invalid/fake/repo.git" });
    assert.equal(result.ok, false);
    assert.match(result.reason, /mirror/);
  } finally {
    cleanupDirs(dir);
  }
});

test("checkPushTargetSafety: fails closed when remote.origin.push is configured", () => {
  const dir = initRepoWithOrigin("https://example.invalid/fake/repo.git");
  try {
    git(["config", "remote.origin.push", "refs/heads/master:refs/heads/other"], dir);
    const result = checkPushTargetSafety({ repoRoot: dir, remote: "origin", expectedRemoteUrl: "https://example.invalid/fake/repo.git" });
    assert.equal(result.ok, false);
    assert.match(result.reason, /remote\.origin\.push/);
  } finally {
    cleanupDirs(dir);
  }
});

test("checkPushTargetSafety: fails closed when an insteadOf URL rewrite rule exists", () => {
  const dir = initRepoWithOrigin("https://example.invalid/fake/repo.git");
  try {
    git(["config", "url.https://rewritten.invalid/.insteadOf", "https://example.invalid/fake/repo.git"], dir);
    const result = checkPushTargetSafety({ repoRoot: dir, remote: "origin", expectedRemoteUrl: "https://example.invalid/fake/repo.git" });
    assert.equal(result.ok, false);
    // The insteadOf rule rewrites get-url's own resolution, so this can fail
    // either via the dedicated insteadOf check or (just as correctly) via a
    // fetch-URL mismatch once the rewritten URL no longer matches expected.
    assert.match(result.reason, /insteadOf|fetch URL/i);
  } finally {
    cleanupDirs(dir);
  }
});

// ---------------------------------------------------------------------------
// checkHookAndFilterPolicy
// ---------------------------------------------------------------------------

test("checkHookAndFilterPolicy: passes on a clean repo with no hooks or filters", () => {
  const dir = initThrowawayRepo();
  try {
    const result = checkHookAndFilterPolicy(dir);
    assert.equal(result.ok, true);
  } finally {
    cleanupDirs(dir);
  }
});

test("checkHookAndFilterPolicy: fails closed when a pre-commit hook file exists", () => {
  const dir = initThrowawayRepo();
  try {
    const hooksDir = path.join(dir, ".git", "hooks");
    writeFileSync(path.join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 0\n", "utf8");
    const result = checkHookAndFilterPolicy(dir);
    assert.equal(result.ok, false);
    assert.match(result.reason, /pre-commit/);
  } finally {
    cleanupDirs(dir);
  }
});

test("checkHookAndFilterPolicy: fails closed when a clean/smudge filter is configured", () => {
  const dir = initThrowawayRepo();
  try {
    git(["config", "filter.testfilter.clean", "cat"], dir);
    const result = checkHookAndFilterPolicy(dir);
    assert.equal(result.ok, false);
    assert.match(result.reason, /filter/);
  } finally {
    cleanupDirs(dir);
  }
});

test("checkHookAndFilterPolicy: fails closed when core.hooksPath is redirected", () => {
  const dir = initThrowawayRepo();
  try {
    git(["config", "core.hooksPath", "some-other-dir"], dir);
    const result = checkHookAndFilterPolicy(dir);
    assert.equal(result.ok, false);
    assert.match(result.reason, /hooksPath/);
  } finally {
    cleanupDirs(dir);
  }
});

// ---------------------------------------------------------------------------
// classifyPushOutcome -- a failed/ambiguous push must never be assumed "not pushed"
// ---------------------------------------------------------------------------

const NEW_HEAD = "1".repeat(40);
const OLD_REMOTE_HEAD = "2".repeat(40);

test("classifyPushOutcome: PUSHED when the live remote already reflects the new commit", () => {
  const outcome = classifyPushOutcome({ liveRemoteResult: { ok: true, sha: NEW_HEAD }, newHead: NEW_HEAD, expectedRemoteHeadBefore: OLD_REMOTE_HEAD });
  assert.equal(outcome.kind, "PUSHED");
});

test("classifyPushOutcome: LOCAL_COMMIT_ONLY when the live remote is confirmed still at the old sha", () => {
  const outcome = classifyPushOutcome({ liveRemoteResult: { ok: true, sha: OLD_REMOTE_HEAD }, newHead: NEW_HEAD, expectedRemoteHeadBefore: OLD_REMOTE_HEAD });
  assert.equal(outcome.kind, "LOCAL_COMMIT_ONLY");
});

test("classifyPushOutcome: UNKNOWN_PUSH_OUTCOME when the live remote cannot be read at all", () => {
  const outcome = classifyPushOutcome({ liveRemoteResult: { ok: false, reason: "network error" }, newHead: NEW_HEAD, expectedRemoteHeadBefore: OLD_REMOTE_HEAD });
  assert.equal(outcome.kind, "UNKNOWN_PUSH_OUTCOME");
});

test("classifyPushOutcome: UNKNOWN_PUSH_OUTCOME when the live remote is at neither the old nor the new sha", () => {
  const outcome = classifyPushOutcome({ liveRemoteResult: { ok: true, sha: "3".repeat(40) }, newHead: NEW_HEAD, expectedRemoteHeadBefore: OLD_REMOTE_HEAD });
  assert.equal(outcome.kind, "UNKNOWN_PUSH_OUTCOME");
});

// ---------------------------------------------------------------------------
// Static source safety checks
// ---------------------------------------------------------------------------

test("source never contains a force-push flag or a '+' force refspec prefix", () => {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  assert.ok(!source.includes("--force"), "must never pass --force");
  assert.ok(!/force-with-lease/.test(source), "must never pass --force-with-lease");
  assert.ok(!/"\+HEAD/.test(source), "must never use a '+' force refspec prefix");
});

test("constants: ALLOWED_BRANCH, ALLOWED_REMOTES, VERIFY_PROFILES", () => {
  assert.equal(ALLOWED_BRANCH, "master");
  assert.deepEqual(ALLOWED_REMOTES, ["origin"]);
  assert.ok(Object.prototype.hasOwnProperty.call(VERIFY_PROFILES, "git-save-self-test"));
});

// ---------------------------------------------------------------------------
// CLI-level integration tests (throwaway repos only -- the real NEXORA repo is never touched)
// ---------------------------------------------------------------------------

function writeManifestFile(manifest) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "git-save-manifest-"));
  const manifestPath = path.join(dir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return { dir, manifestPath };
}

function runCli(manifestPath, extraArgs = [], cwd) {
  try {
    const output = execFileSync("node", [SCRIPT_PATH, "--manifest", manifestPath, ...extraArgs], {
      cwd, encoding: "utf8", stdio: "pipe",
    });
    return { code: 0, output };
  } catch (err) {
    return { code: err.status ?? 1, output: `${err.stdout || ""}${err.stderr || ""}` };
  }
}

test("CLI: rejects a schema-invalid manifest and touches nothing", () => {
  const { localDir, remoteDir } = initThrowawayRepoWithRemote();
  const { dir: manifestDir, manifestPath } = writeManifestFile({ version: 2 });
  try {
    const headBefore = git(["rev-parse", "HEAD"], localDir);
    const result = runCli(manifestPath, [], localDir);
    assert.notEqual(result.code, 0);
    assert.match(result.output, /manifest validation/);
    assert.equal(git(["rev-parse", "HEAD"], localDir), headBefore);
    assert.equal(git(["status", "--porcelain"], localDir), "");
  } finally {
    cleanupDirs(localDir, remoteDir, manifestDir);
  }
});

test("CLI: aborts at remote preflight when histories have diverged, leaving the repo untouched", () => {
  const { localDir, remoteDir, head } = initThrowawayRepoWithRemote();
  try {
    // Diverge refs/remotes/origin/master from local HEAD via plumbing only (no real push/fetch).
    const baseTree = git(["write-tree"], localDir);
    const divergedCommit = execFileSync("git", ["commit-tree", baseTree, "-p", head, "-m", "diverged"], { cwd: localDir, encoding: "utf8" }).trim();
    execFileSync("git", ["update-ref", "refs/remotes/origin/master", divergedCommit], { cwd: localDir, stdio: "pipe" });
    writeFileSync(path.join(localDir, "local-only.txt"), "local\n", "utf8");
    git(["add", "local-only.txt"], localDir);
    git(["commit", "-m", "local-only"], localDir);
    const headAfterLocalCommit = git(["rev-parse", "HEAD"], localDir);
    // A separate, still-uncommitted file so the "approved path has a real
    // change" precheck passes and the run actually reaches remote preflight.
    writeFileSync(path.join(localDir, "new-file.txt"), "hello\n", "utf8");

    const { dir: manifestDir, manifestPath } = writeManifestFile(validManifest(localDir, {
      expectedHeadBefore: headAfterLocalCommit,
      expectedRemoteHeadBefore: divergedCommit,
      approvedPaths: ["new-file.txt"],
    }));
    try {
      const result = runCli(manifestPath, [], localDir);
      assert.notEqual(result.code, 0);
      assert.match(result.output, /remote preflight/);
      assert.equal(git(["rev-parse", "HEAD"], localDir), headAfterLocalCommit, "HEAD must not move");
      assert.equal(git(["diff", "--cached", "--name-only"], localDir), "", "nothing must be staged");
    } finally {
      cleanupDirs(manifestDir);
    }
  } finally {
    cleanupDirs(localDir, remoteDir);
  }
});

test("CLI: refuses to run when the real index already has staged content before this run", () => {
  const { localDir, remoteDir } = initThrowawayRepoWithRemote();
  try {
    writeFileSync(path.join(localDir, "new-file.txt"), "hello\n", "utf8");
    git(["add", "new-file.txt"], localDir); // pre-existing staged content, unrelated to this run

    const { dir: manifestDir, manifestPath } = writeManifestFile(validManifest(localDir, { approvedPaths: ["new-file.txt"] }));
    try {
      const result = runCli(manifestPath, [], localDir);
      assert.notEqual(result.code, 0);
      assert.match(result.output, /clean index/);
      assert.equal(git(["diff", "--cached", "--name-only"], localDir), "new-file.txt", "pre-existing staged content must be left exactly as-is");
    } finally {
      cleanupDirs(manifestDir);
    }
  } finally {
    cleanupDirs(localDir, remoteDir);
  }
});

test("CLI: push-target safety gate rejects a rewritten push URL before any staging happens", () => {
  const { localDir, remoteDir } = initThrowawayRepoWithRemote();
  try {
    git(["remote", "set-url", "--push", "origin", "https://example.invalid/different/repo.git"], localDir);
    writeFileSync(path.join(localDir, "new-file.txt"), "hello\n", "utf8");

    const { dir: manifestDir, manifestPath } = writeManifestFile(validManifest(localDir, { approvedPaths: ["new-file.txt"] }));
    try {
      const result = runCli(manifestPath, [], localDir);
      assert.notEqual(result.code, 0);
      assert.match(result.output, /push target safety/);
      assert.equal(git(["diff", "--cached", "--name-only"], localDir), "", "nothing must be staged");
    } finally {
      cleanupDirs(manifestDir);
    }
  } finally {
    cleanupDirs(localDir, remoteDir);
  }
});

test("CLI: --help exits 0 without requiring a manifest", () => {
  const output = execFileSync("node", [SCRIPT_PATH, "--help"], { encoding: "utf8" });
  assert.match(output, /NEXORA Git Save Gate/);
});
