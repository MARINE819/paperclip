#!/usr/bin/env node
/**
 * NEXORA Git Save Request Preparer.
 *
 * AI employees may run this read/preparation step. It never stages, commits,
 * fetches, merges, rebases, or pushes. It converts a small request JSON into a
 * version-2 manifest whose exact approved Git tree is cryptographically bound.
 *
 * Only a human may run git-save.mjs and type the final SAVE confirmation.
 *
 * Usage:
 *   node scripts/operations/git-save-prepare.mjs --request <request.json> [--output <manifest.json>]
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_BRANCH,
  ALLOWED_REMOTES,
  ALLOWED_REMOTE_URLS,
  VERIFY_PROFILES,
  buildIsolatedApprovedPreview,
  checkHookAndFilterPolicy,
  checkPushTargetSafety,
  checkRemoteFastForwardSafety,
  isSafeApprovedPath,
  readLiveRemoteHead,
  validateApprovedPathOnDisk,
  validateManifest,
} from "./git-save.mjs";

function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", stdio: "pipe", ...options }).trim();
}

function normalizePath(value) {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function parsePrepareArgs(argv) {
  const result = { requestPath: null, outputPath: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--request") {
      result.requestPath = argv[++index] ?? null;
    } else if (arg === "--output") {
      result.outputPath = argv[++index] ?? null;
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return result;
}

export function validatePrepareRequest(request, { repoRoot }) {
  const errors = [];
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return ["request must be a JSON object"];
  }
  if (!Array.isArray(request.approvedPaths) || request.approvedPaths.length === 0) {
    errors.push("request.approvedPaths must be a non-empty array of exact file paths");
  } else {
    const seen = new Map();
    for (const approvedPath of request.approvedPaths) {
      if (!isSafeApprovedPath(repoRoot, approvedPath)) {
        errors.push(`request.approvedPaths contains an unsafe/invalid entry: ${JSON.stringify(approvedPath)}`);
        continue;
      }
      const normalized = normalizePath(path.resolve(repoRoot, approvedPath));
      if (seen.has(normalized)) {
        errors.push(`request.approvedPaths contains the same file more than once: ${JSON.stringify(approvedPath)}`);
      } else {
        seen.set(normalized, approvedPath);
      }
    }
  }
  if (typeof request.verifyProfile !== "string" || !Object.hasOwn(VERIFY_PROFILES, request.verifyProfile)) {
    errors.push(`request.verifyProfile must be one of ${JSON.stringify(Object.keys(VERIFY_PROFILES))}`);
  }
  if (typeof request.commitMessage !== "string" || !request.commitMessage.trim()) {
    errors.push("request.commitMessage is required and must be non-empty");
  } else if (request.commitMessage.length > 5000) {
    errors.push("request.commitMessage is implausibly long (>5000 chars)");
  }
  if (typeof request.requestedBy !== "string" || !request.requestedBy.trim()) {
    errors.push("request.requestedBy is required and must identify the requesting AI employee");
  }
  if (typeof request.reason !== "string" || !request.reason.trim()) {
    errors.push("request.reason is required and must explain why these files should be saved");
  }
  return errors;
}

function usage() {
  console.log([
    "NEXORA Git Save Request Preparer",
    "",
    "Usage:",
    "  node scripts/operations/git-save-prepare.mjs --request <request.json> [--output <manifest.json>]",
    "",
    "The request JSON must contain approvedPaths, verifyProfile, commitMessage, requestedBy, and reason.",
    "This command only prepares a content-bound manifest. It never stages, commits, or pushes.",
  ].join("\n"));
}

function fail(stage, message, exitCode = 1) {
  console.error(`\n[git-save-prepare] FAILED at ${stage}: ${message}\n`);
  process.exitCode = exitCode;
}

export async function prepareRequest({ repoRoot, request, outputPath }) {
  const errors = validatePrepareRequest(request, { repoRoot });
  if (errors.length > 0) {
    throw new Error(`request validation:\n  - ${errors.join("\n  - ")}`);
  }

  const branch = git(["branch", "--show-current"], { cwd: repoRoot });
  if (branch !== ALLOWED_BRANCH) {
    throw new Error(`current branch is ${JSON.stringify(branch)}, expected ${JSON.stringify(ALLOWED_BRANCH)}`);
  }

  const staged = git(["diff", "--cached", "--name-only"], { cwd: repoRoot });
  if (staged) {
    throw new Error(`the Git index is not clean; unstage these files before preparing a request:\n${staged}`);
  }

  const hookPolicy = checkHookAndFilterPolicy(repoRoot);
  if (!hookPolicy.ok) throw new Error(hookPolicy.reason);

  const remote = ALLOWED_REMOTES[0];
  const expectedRemoteUrl = ALLOWED_REMOTE_URLS[0];
  const pushTarget = checkPushTargetSafety({ repoRoot, remote, expectedRemoteUrl });
  if (!pushTarget.ok) throw new Error(pushTarget.reason);

  const expectedHeadBefore = git(["rev-parse", "HEAD"], { cwd: repoRoot });
  let expectedRemoteHeadBefore;
  try {
    expectedRemoteHeadBefore = git(["rev-parse", `refs/remotes/${remote}/${ALLOWED_BRANCH}`], { cwd: repoRoot });
  } catch {
    throw new Error(`no local record of ${remote}/${ALLOWED_BRANCH}; a human must fetch and retry`);
  }

  for (const approvedPath of request.approvedPaths) {
    const status = execFileSync(
      "git",
      ["status", "--porcelain=v1", "--", `:(literal)${approvedPath}`],
      { cwd: repoRoot, encoding: "utf8", stdio: "pipe" },
    );
    if (!status.trim()) throw new Error(`no change detected at approved path: ${approvedPath}`);
    const diskCheck = validateApprovedPathOnDisk(repoRoot, approvedPath);
    if (!diskCheck.ok) throw new Error(diskCheck.reason);
  }

  const remotePreflight = checkRemoteFastForwardSafety({
    repoRoot,
    remote,
    branch: ALLOWED_BRANCH,
    expectedRemoteHeadBefore,
  });
  if (!remotePreflight.ok) throw new Error(remotePreflight.reason);

  const liveRemote = readLiveRemoteHead(repoRoot, remote, ALLOWED_BRANCH);
  if (!liveRemote.ok) throw new Error(liveRemote.reason);
  if (liveRemote.sha !== expectedRemoteHeadBefore) {
    throw new Error(
      `live ${remote}/${ALLOWED_BRANCH} is ${liveRemote.sha}, but the local record is ${expectedRemoteHeadBefore}; a human must fetch and retry`,
    );
  }

  const preview = buildIsolatedApprovedPreview(repoRoot, request.approvedPaths);
  const manifest = {
    version: 2,
    expectedRepoRoot: repoRoot,
    expectedRemoteUrl,
    remote,
    branch: ALLOWED_BRANCH,
    expectedHeadBefore,
    expectedRemoteHeadBefore,
    expectedApprovedTree: preview.treeOid,
    approvedPaths: [...request.approvedPaths],
    verifyProfile: request.verifyProfile,
    commitMessage: request.commitMessage,
    requestedBy: request.requestedBy,
    reason: request.reason,
    preparedAt: new Date().toISOString(),
  };
  const manifestErrors = validateManifest(manifest, { repoRoot });
  if (manifestErrors.length > 0) {
    throw new Error(`generated manifest failed validation:\n  - ${manifestErrors.join("\n  - ")}`);
  }

  const resolvedOutput = path.resolve(repoRoot, outputPath ?? `scratch/git-save-request-${Date.now()}.json`);
  const relativeOutput = path.relative(repoRoot, resolvedOutput);
  if (!relativeOutput || relativeOutput.startsWith("..") || path.isAbsolute(relativeOutput)) {
    throw new Error("output path must be a file inside the repository");
  }
  if (normalizePath(relativeOutput).startsWith(".git/")) {
    throw new Error("output path must not be inside .git");
  }
  if (existsSync(resolvedOutput)) {
    throw new Error(`output file already exists; refusing to overwrite: ${resolvedOutput}`);
  }
  writeFileSync(resolvedOutput, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return { manifest, preview, outputPath: resolvedOutput };
}

async function main() {
  let args;
  try {
    args = parsePrepareArgs(process.argv.slice(2));
  } catch (error) {
    usage();
    fail("arguments", error.message, 2);
    return;
  }
  if (args.help || !args.requestPath) {
    usage();
    process.exitCode = args.help ? 0 : 2;
    return;
  }

  const repoRoot = git(["rev-parse", "--show-toplevel"]);
  const requestPath = path.resolve(repoRoot, args.requestPath);
  if (!existsSync(requestPath)) {
    fail("request load", `request file not found: ${requestPath}`);
    return;
  }
  let request;
  try {
    request = JSON.parse(readFileSync(requestPath, "utf8"));
  } catch (error) {
    fail("request load", `request is not valid JSON: ${error.message}`);
    return;
  }

  try {
    const result = await prepareRequest({ repoRoot, request, outputPath: args.outputPath });
    console.log("\n[git-save-prepare] READY FOR CEO REVIEW");
    console.log(`Manifest: ${result.outputPath}`);
    console.log(`Approved files: ${result.manifest.approvedPaths.length}`);
    console.log(`Approved tree: ${result.manifest.expectedApprovedTree}`);
    console.log("No files were staged, committed, or pushed.");
    console.log("\nA human CEO may review and run:");
    console.log(`node scripts/operations/git-save.mjs --manifest ${JSON.stringify(result.outputPath)}`);
  } catch (error) {
    fail("preparation", error.message);
  }
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  main().catch((error) => fail("unexpected error", error.stack || error.message));
}

