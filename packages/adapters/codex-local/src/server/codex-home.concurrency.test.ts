import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexHomeHasUsableAuth, prepareManagedCodexHome } from "./codex-home.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-concurrency-"));
  roots.push(root);
  const sourceHome = path.join(root, "source-codex");
  await fs.mkdir(sourceHome, { recursive: true });
  await fs.writeFile(path.join(sourceHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "test-key" }));
  const env = {
    ...process.env,
    CODEX_HOME: sourceHome,
    PAPERCLIP_HOME: path.join(root, "paperclip"),
    PAPERCLIP_INSTANCE_ID: "test",
  };
  return { env, targetHome: path.join(root, "paperclip", "instances", "test", "companies", "company-1", "codex-home") };
}

describe("Codex managed-home preparation concurrency", () => {
  it("preserves single-agent preparation behavior", async () => {
    const { env, targetHome } = await fixture();
    await prepareManagedCodexHome(env, async () => undefined, "company-1");
    await expect(codexHomeHasUsableAuth(targetHome)).resolves.toBe(true);
  });

  it("prepares one shared home safely for multiple concurrent agents", async () => {
    const { env, targetHome } = await fixture();
    await Promise.all(Array.from({ length: 10 }, () =>
      prepareManagedCodexHome(env, async () => undefined, "company-1")));
    await expect(codexHomeHasUsableAuth(targetHome)).resolves.toBe(true);
    expect((await fs.readdir(targetHome)).filter((name) => name.includes(".prepare-"))).toEqual([]);
  });
});
