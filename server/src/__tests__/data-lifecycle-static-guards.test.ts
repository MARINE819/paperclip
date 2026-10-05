import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// F-01 Data Lifecycle static source guards. These are the same
// grep-based non-negotiable checks used by the F-02/F-05/F-06 batches:
// assert forbidden patterns are ABSENT from source text, rather than
// relying solely on runtime behavior tests.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVICES_DIR = path.resolve(__dirname, "../services");
const ROUTES_DIR = path.resolve(__dirname, "../routes");

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

describe("F-01 data-lifecycle static source guards", () => {
  it("[zero mutation] data-lifecycle-dry-run.ts never calls a Drizzle .insert(/.update(/.delete( method", () => {
    const source = read(path.join(SERVICES_DIR, "data-lifecycle-dry-run.ts"));
    expect(source).not.toMatch(/\.(insert|update|delete)\(/);
  });

  it("[zero mutation] data-lifecycle-dry-run.ts never imports fs write/unlink primitives", () => {
    const source = read(path.join(SERVICES_DIR, "data-lifecycle-dry-run.ts"));
    expect(source).not.toMatch(/writeFileSync|unlinkSync|rmSync|rmdirSync|appendFileSync/);
  });

  it("[zero mutation] data-lifecycle-classification.ts is a pure mapping with no db/fs imports at all", () => {
    const source = read(path.join(SERVICES_DIR, "data-lifecycle-classification.ts"));
    expect(source).not.toMatch(/from ["']@paperclipai\/db["']/);
    expect(source).not.toMatch(/from ["']node:fs["']/);
  });

  it("[no reimplementation] the new F-01 files never import existing domain-specific retention/cleanup modules", () => {
    // backup-lib is deliberately excluded here — the dry-run engine's
    // backup_metadata path documents in a comment that it mirrors
    // backup-lib's cutoff math WITHOUT importing or calling it; that
    // non-call is asserted precisely by the "never calls pruneOldBackups
    // directly" guard below rather than by a blanket substring ban.
    const forbiddenImports = [
      "decision-retention",
      "plugin-log-retention",
      "workspace-instance-cleanup",
      "sandbox-orphan-cleanup-spool",
      "setup-token-reaper",
      "codex-device-login-reaper",
    ];
    for (const file of ["data-lifecycle-dry-run.ts", "data-lifecycle-classification.ts"]) {
      const source = read(path.join(SERVICES_DIR, file));
      for (const forbidden of forbiddenImports) {
        expect(source, `${file} must not import ${forbidden}`).not.toContain(forbidden);
      }
      expect(source, `${file} must not actually import backup-lib`).not.toMatch(/from ["'][^"']*backup-lib[^"']*["']/);
    }
  });

  it("[READ-ONLY API] data-lifecycle.ts registers only GET routes — no POST/PATCH/PUT/DELETE this batch", () => {
    const source = read(path.join(ROUTES_DIR, "data-lifecycle.ts"));
    expect(source).not.toMatch(/router\.(post|patch|put|delete)\(/);
    expect(source.match(/router\.get\(/g)?.length).toBe(3);
  });

  it("[no forced mapping] backup_metadata dry-run never calls pruneOldBackups directly", () => {
    const source = read(path.join(SERVICES_DIR, "data-lifecycle-dry-run.ts"));
    expect(source).not.toMatch(/pruneOldBackups\s*\(/);
  });
});
