import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { 
  evaluateActionSafety, 
  isPathProtected, 
  checkSqlDestructiveness, 
  checkCommandDestructiveness,
  stripSqlComments,
  tokenizeShellCommand
} from "../services/system-guard.js";

const OVERRIDE_TEST_TOKEN = "TEST-EMERGENCY-TOKEN-12345";

beforeAll(() => {
  process.env.NEXORA_EMERGENCY_OVERRIDE_TOKEN = OVERRIDE_TEST_TOKEN;
});

afterAll(() => {
  delete process.env.NEXORA_EMERGENCY_OVERRIDE_TOKEN;
});

describe("System Guard - Tokenizers & Strippers", () => {
  it("strips SQL comments correctly", () => {
    expect(stripSqlComments("DROP /**/ DATABASE test;")).toBe("DROP   DATABASE test;");
    expect(stripSqlComments("SELECT * FROM users; -- get all users")).toBe("SELECT * FROM users;");
  });

  it("tokenizes shell commands correctly including quotes", () => {
    expect(tokenizeShellCommand('rm -rf "my folder"')).toEqual(["rm", "-rf", "my folder"]);
  });
});

describe("System Guard - Path Guard & Hardened Bypasses", () => {
  it("blocks all hardened protected paths under any casing, traversal, or separator type", () => {
    expect(isPathProtected(".env")).toBe(true);
    expect(isPathProtected(".ENV.LOCAL")).toBe(true);
    expect(isPathProtected("package.json")).toBe(true);
    expect(isPathProtected("pnpm-lock.yaml")).toBe(true);
    expect(isPathProtected("drizzle/")).toBe(true);
    expect(isPathProtected("migrations/")).toBe(true);
    expect(isPathProtected("packages/db/")).toBe(true);

    expect(isPathProtected("C:\\Users\\Nexora\\paperclip\\.env")).toBe(true);
    expect(isPathProtected("C:/Users/Nexora/paperclip/packages/db/src/client.ts")).toBe(true);
    expect(isPathProtected("src/services/../../.env")).toBe(true);
  });
});

describe("System Guard - SQL Guard Hardening", () => {
  it("blocks drop/truncate/alter and delete/update without where clauses", () => {
    expect(checkSqlDestructiveness("DROP /**/ TABLE users;").destructive).toBe(true);
    expect(checkSqlDestructiveness("DELETE FROM users;").destructive).toBe(true);
    expect(checkSqlDestructiveness("DELETE FROM users WHERE 1=1;").destructive).toBe(true);
    expect(checkSqlDestructiveness("DELETE FROM users WHERE TRUE;").destructive).toBe(true);
    expect(checkSqlDestructiveness("DELETE FROM users WHERE id = 1;").destructive).toBe(false);
  });

  it("blocks vacuum, reindex, cluster", () => {
    expect(checkSqlDestructiveness("VACUUM FULL;").destructive).toBe(true);
    expect(checkSqlDestructiveness("REINDEX DATABASE test;").destructive).toBe(true);
    expect(checkSqlDestructiveness("CLUSTER table_name;").destructive).toBe(true);
  });
});

describe("System Guard - Shell Commands & PowerShell/Linux Aliases", () => {
  it("blocks rm, del, rmdir, erase, rd, Remove-Item, Remove-ItemProperty, ri", () => {
    expect(checkCommandDestructiveness("rm -rf mypath").destructive).toBe(true);
    expect(checkCommandDestructiveness("del myfile").destructive).toBe(true);
    expect(checkCommandDestructiveness("Remove-Item -Path myfile").destructive).toBe(true);
    expect(checkCommandDestructiveness("Remove-ItemProperty -Path myfile").destructive).toBe(true);
    expect(checkCommandDestructiveness("ri -Path myfile").destructive).toBe(true);
    expect(checkCommandDestructiveness("erase myfile").destructive).toBe(true);
    expect(checkCommandDestructiveness("rd mydir").destructive).toBe(true);
  });

  it("blocks nested PowerShell and cmd /c bypasses", () => {
    expect(checkCommandDestructiveness('powershell -Command "rm -rf mypath"').destructive).toBe(true);
    expect(checkCommandDestructiveness('cmd.exe /c "del myfile"').destructive).toBe(true);
    expect(checkCommandDestructiveness('pwsh -c "Remove-Item myfile"').destructive).toBe(true);
  });
});

describe("System Guard - Emergency Override & Modes", () => {
  it("allows critical action in Maintenance mode with valid token", async () => {
    const result = await evaluateActionSafety({
      actor: "test-actor",
      actionType: "shell",
      payload: "rm -rf something",
      mode: "Maintenance",
      approvedByBoard: true,
      emergencyOverrideToken: OVERRIDE_TEST_TOKEN
    });

    expect(result.allowed).toBe(true);
  });

  it("denies critical action in Production mode even with valid token", async () => {
    const result = await evaluateActionSafety({
      actor: "test-actor",
      actionType: "shell",
      payload: "rm -rf something",
      mode: "Production",
      approvedByBoard: true,
      emergencyOverrideToken: OVERRIDE_TEST_TOKEN
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Production Mode restriction");
  });

  it("denies critical action in Maintenance mode with invalid token", async () => {
    const result = await evaluateActionSafety({
      actor: "test-actor",
      actionType: "shell",
      payload: "rm -rf something",
      mode: "Maintenance",
      approvedByBoard: true,
      emergencyOverrideToken: "WRONG-TOKEN"
    });

    expect(result.allowed).toBe(false);
  });
});

describe("System Guard - Explain Mode", () => {
  it("provides detailed reason structures when blocked", async () => {
    const result = await evaluateActionSafety({
      actor: "test-actor",
      actionType: "sql",
      payload: "DROP TABLE users;",
      mode: "Production",
      approvedByBoard: false
    });

    expect(result.allowed).toBe(false);
    expect(result.matchedRule).toBe("FORBIDDEN_SQL");
    expect(result.severity).toBe("CRITICAL");
    expect(result.matchedToken).toBe("DROP");
    expect(result.suggestedAction).toBe("Use migration instead.");
  });
});

describe("System Guard - Fail-Closed Validation", () => {
  it("fails closed on timeout", async () => {
    const result = await evaluateActionSafety({
      actor: "test-actor",
      actionType: "shell",
      payload: "dir",
      mode: "Development",
      approvedByBoard: false,
      timeoutMs: 1
    });

    expect(result.allowed).toBe(false);
    expect(result.matchedRule).toBe("FAIL_CLOSED");
  });

  it("fails closed on internal exceptions/crashes", async () => {
    const result = await evaluateActionSafety({
      actor: "test-actor",
      actionType: "shell",
      payload: null as any,
      mode: "Development",
      approvedByBoard: false
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("System Guard internal exception");
  });
});
