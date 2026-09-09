import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { KnowledgeRecord } from "@paperclipai/shared";

/**
 * Phase 2.2 minimal, one-way Knowledge Record -> Obsidian Markdown sync.
 *
 * Security model: the vault root comes only from server configuration
 * (`obsidian-vault-config.ts`) and the relative file path is always computed
 * here from the record's own id/title, never accepted from a client. Every
 * path is still re-validated and containment-checked as if it were
 * untrusted, so this module fails closed even if a future caller passes a
 * bad value.
 */

const KNOWLEDGE_SUBDIRECTORY = "knowledge";

export class ObsidianVaultConfigurationError extends Error {}
export class ObsidianVaultPathViolationError extends Error {}

/** Rejects the relative-path shapes that indicate an attempted escape, independent of OS. */
function assertSafeVaultRelativePath(relativePath: string): void {
  if (!relativePath || relativePath.trim() === "") {
    throw new ObsidianVaultPathViolationError("relative path must not be empty");
  }
  // Windows drive-letter forms: "C:\\foo" and the drive-relative "C:foo".
  if (/^[a-zA-Z]:/.test(relativePath)) {
    throw new ObsidianVaultPathViolationError("relative path must not include a drive letter");
  }
  // UNC forms: "\\\\server\\share" and the POSIX-ish "//server/share".
  if (/^[\\/]{2}/.test(relativePath)) {
    throw new ObsidianVaultPathViolationError("relative path must not be a UNC path");
  }
  if (path.win32.isAbsolute(relativePath) || path.posix.isAbsolute(relativePath)) {
    throw new ObsidianVaultPathViolationError("relative path must not be absolute");
  }
  const segments = relativePath.split(/[\\/]+/);
  if (segments.some((segment) => segment === "..")) {
    throw new ObsidianVaultPathViolationError("relative path must not contain '..' segments");
  }
}

/**
 * Resolves `relativePath` under `vaultRoot`, validating both the lexical
 * shape (see `assertSafeVaultRelativePath`) and, once the containing
 * directory exists, the real (symlink-resolved) location — so a symlink
 * planted inside the vault cannot redirect a write outside of it.
 */
export async function resolveVaultRelativePath(
  vaultRoot: string,
  relativePath: string,
): Promise<{ absolutePath: string; parentDir: string }> {
  assertSafeVaultRelativePath(relativePath);

  let realVaultRoot: string;
  try {
    realVaultRoot = await fs.realpath(vaultRoot);
  } catch {
    throw new ObsidianVaultConfigurationError("configured vault root is not accessible");
  }

  const absolutePath = path.resolve(realVaultRoot, relativePath);
  const relativeToRoot = path.relative(realVaultRoot, absolutePath);
  if (relativeToRoot === "" || relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new ObsidianVaultPathViolationError("resolved path escapes the vault root");
  }

  const parentDir = path.dirname(absolutePath);
  await fs.mkdir(parentDir, { recursive: true });

  // Re-check containment against the *real* parent directory after creation,
  // so a symlink swapped in for one of the intermediate directories cannot
  // redirect the write outside the vault (fail closed, not best-effort).
  const realParentDir = await fs.realpath(parentDir);
  const relativeParent = path.relative(realVaultRoot, realParentDir);
  if (relativeParent === ".." || relativeParent.startsWith(`..${path.sep}`) || path.isAbsolute(relativeParent)) {
    throw new ObsidianVaultPathViolationError("resolved directory escapes the vault root");
  }

  return { absolutePath: path.join(realParentDir, path.basename(absolutePath)), parentDir: realParentDir };
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Deterministic, collision-free relative path for a record: stable across re-syncs. */
export function vaultRelativePathForKnowledgeRecord(record: Pick<KnowledgeRecord, "id" | "title">): string {
  const slug = slugify(record.title) || "note";
  return path.posix.join(KNOWLEDGE_SUBDIRECTORY, `${slug}-${record.id}.md`);
}

/** JSON string escaping is a valid subset of YAML double-quoted scalar escaping. */
function yamlDoubleQuoted(value: string): string {
  return JSON.stringify(value);
}

/**
 * Renders the Markdown file content. `body` is embedded verbatim after the
 * frontmatter block — Obsidian (and any standard Markdown parser) only
 * treats a `---` block as frontmatter when it starts at byte 0 of the file,
 * so nothing inside `body` needs to be altered to protect the frontmatter.
 */
export function renderKnowledgeMarkdown(record: Pick<KnowledgeRecord, "id" | "companyId" | "title" | "summary" | "body">): string {
  const lines = [
    "---",
    `paperclipKnowledgeRecordId: ${yamlDoubleQuoted(record.id)}`,
    `paperclipCompanyId: ${yamlDoubleQuoted(record.companyId)}`,
    `title: ${yamlDoubleQuoted(record.title)}`,
  ];
  if (record.summary) {
    lines.push(`summary: ${yamlDoubleQuoted(record.summary)}`);
  }
  lines.push("---", "", record.body);
  return lines.join("\n");
}

/** Maps a caught error to a message safe to persist/log/return — never echoes filesystem paths. */
export function sanitizeObsidianSyncError(error: unknown): string {
  if (error instanceof ObsidianVaultConfigurationError) {
    return "Obsidian vault is not configured or not accessible on the server.";
  }
  if (error instanceof ObsidianVaultPathViolationError) {
    return "Resolved sync path failed the vault containment check.";
  }
  const code = (error as { code?: string } | null)?.code;
  switch (code) {
    case "ENOENT":
      return "A required directory for the sync target was not found.";
    case "EACCES":
    case "EPERM":
      return "The server does not have filesystem permission to write to the vault.";
    case "ENOSPC":
      return "No space left on the device hosting the vault.";
    case "EROFS":
      return "The vault filesystem is read-only.";
    default:
      return "Obsidian sync failed due to an unexpected filesystem error.";
  }
}

/** Writes `content` to `absolutePath` by writing a same-directory temp file and renaming it into place. */
async function writeFileAtomic(absolutePath: string, content: string): Promise<void> {
  const dir = path.dirname(absolutePath);
  const tempPath = path.join(dir, `.${path.basename(absolutePath)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(tempPath, content, "utf8");
    await fs.rename(tempPath, absolutePath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

export type ObsidianSyncOutcome =
  | { state: "synced"; relativePath: string }
  | { state: "failed"; error: string };

/**
 * Performs one sync attempt for a single Knowledge Record. Never throws —
 * every failure mode is captured and returned as `{ state: "failed", ... }`
 * so the caller can persist the outcome without a try/catch of its own.
 */
export async function syncKnowledgeRecordToObsidian(
  vaultRoot: string | null,
  record: Pick<KnowledgeRecord, "id" | "companyId" | "title" | "summary" | "body"> & { obsidianPath: string | null },
): Promise<ObsidianSyncOutcome> {
  try {
    if (!vaultRoot) {
      throw new ObsidianVaultConfigurationError("no vault root configured");
    }
    const relativePath = record.obsidianPath ?? vaultRelativePathForKnowledgeRecord(record);
    const { absolutePath } = await resolveVaultRelativePath(vaultRoot, relativePath);
    const content = renderKnowledgeMarkdown(record);
    await writeFileAtomic(absolutePath, content);
    return { state: "synced", relativePath };
  } catch (error) {
    return { state: "failed", error: sanitizeObsidianSyncError(error) };
  }
}
