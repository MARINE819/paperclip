import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  reconcileManagedFileLink,
  withManagedHomePreparationLock,
  writeManagedFileAtomically,
} from "./managed-home-preparation.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-home-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("managed home preparation", () => {
  it("runs a single preparation and returns its result", async () => {
    const root = await tempRoot();
    await expect(withManagedHomePreparationLock(root, async () => "ready")).resolves.toBe("ready");
  });

  it("serializes concurrent callers targeting the same home", async () => {
    const root = await tempRoot();
    let active = 0;
    let maxActive = 0;
    const completions: number[] = [];
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      withManagedHomePreparationLock(root, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        completions.push(index);
        active -= 1;
      })));
    expect(maxActive).toBe(1);
    expect(completions).toEqual(Array.from({ length: 12 }, (_, index) => index));
  });

  it("keeps a Windows-style fallback copy stable and refreshes it atomically", async () => {
    const root = await tempRoot();
    const source = path.join(root, "source", "auth.json");
    const target = path.join(root, "managed", "auth.json");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, '{"tokens":{"account_id":"one"}}');
    let symlinkAttempts = 0;
    const denySymlink = async () => {
      symlinkAttempts += 1;
      throw Object.assign(new Error("symlink denied"), { code: "EPERM" });
    };

    await withManagedHomePreparationLock(path.dirname(target), () =>
      reconcileManagedFileLink(target, source, { createSymlink: denySymlink }));
    const firstStat = await fs.stat(target);
    await withManagedHomePreparationLock(path.dirname(target), () =>
      reconcileManagedFileLink(target, source, { createSymlink: denySymlink }));
    expect(symlinkAttempts).toBe(1);
    expect((await fs.stat(target)).mtimeMs).toBe(firstStat.mtimeMs);

    await fs.writeFile(source, '{"tokens":{"account_id":"two"}}');
    await withManagedHomePreparationLock(path.dirname(target), () =>
      reconcileManagedFileLink(target, source, { createSymlink: denySymlink }));
    expect(await fs.readFile(target, "utf8")).toContain('"two"');
    expect((await fs.readdir(path.dirname(target))).filter((name) => name.includes(".prepare-"))).toEqual([]);
  });

  it("atomically replaces managed API-key authentication", async () => {
    const root = await tempRoot();
    const target = path.join(root, "auth.json");
    await writeManagedFileAtomically(target, '{"OPENAI_API_KEY":"first"}');
    await writeManagedFileAtomically(target, '{"OPENAI_API_KEY":"second"}');
    expect(await fs.readFile(target, "utf8")).toBe('{"OPENAI_API_KEY":"second"}');
    expect((await fs.readdir(root)).filter((name) => name.includes(".write-"))).toEqual([]);
  });
});
