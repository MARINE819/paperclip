import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const preparationLocks = new Map<string, Promise<void>>();

function normalizeLockKey(home: string): string {
  const resolved = path.resolve(home);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Serialize preparation of one managed home, without serializing execution. */
export async function withManagedHomePreparationLock<T>(
  home: string,
  prepare: () => Promise<T>,
): Promise<T> {
  const key = normalizeLockKey(home);
  const previous = preparationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.catch(() => undefined).then(() => gate);
  preparationLocks.set(key, current);
  await previous.catch(() => undefined);
  try {
    return await prepare();
  } finally {
    release();
    if (preparationLocks.get(key) === current) preparationLocks.delete(key);
  }
}

export type ManagedFileLinkMode = "symlink" | "copy";

type ReconcileManagedFileLinkOptions = {
  createSymlink?: (source: string, target: string) => Promise<void>;
};

async function filesEqual(left: string, right: string): Promise<boolean> {
  try {
    const [leftBytes, rightBytes] = await Promise.all([fs.readFile(left), fs.readFile(right)]);
    return leftBytes.equals(rightBytes);
  } catch {
    return false;
  }
}

async function isExpectedSymlink(target: string, source: string): Promise<boolean> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing?.isSymbolicLink()) return false;
  const linkedPath = await fs.readlink(target).catch(() => null);
  return linkedPath != null && path.resolve(path.dirname(target), linkedPath) === path.resolve(source);
}

export async function writeManagedFileAtomically(
  target: string,
  contents: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.write-${process.pid}-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, contents, { mode, flag: "wx" });
    await fs.chmod(temp, mode).catch(() => undefined);
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

/**
 * Atomically installs a managed-file symlink. Windows symlink EPERM falls back
 * to a stable copy; matching copies are retained instead of recreated.
 */
export async function reconcileManagedFileLink(
  target: string,
  source: string,
  options: ReconcileManagedFileLinkOptions = {},
): Promise<ManagedFileLinkMode> {
  const resolvedSource = path.resolve(source);
  const existing = await fs.lstat(target).catch(() => null);
  if (existing?.isDirectory()) throw new Error(`Managed file target is a directory: ${target}`);
  if (existing?.isSymbolicLink() && await isExpectedSymlink(target, resolvedSource)) return "symlink";
  if (existing?.isFile() && await filesEqual(target, resolvedSource)) return "copy";

  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.prepare-${process.pid}-${randomUUID()}.tmp`);
  const createSymlink = options.createSymlink ?? ((from, to) => fs.symlink(from, to));
  let mode: ManagedFileLinkMode = "symlink";
  try {
    try {
      await createSymlink(resolvedSource, temp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== "EPERM") throw error;
      mode = "copy";
      await fs.copyFile(resolvedSource, temp);
      await fs.chmod(temp, 0o600).catch(() => undefined);
    }
    await fs.rename(temp, target);
    return mode;
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}
