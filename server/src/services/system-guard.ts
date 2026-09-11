import { createHash } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { 
  PROTECTED_PATHS, 
  FORBIDDEN_COMMANDS, 
  FORBIDDEN_SQL_STATEMENTS, 
  OperationalMode, 
  MODE_RULES 
} from "./system-guard-rules.js";

export interface AuditEventPayload {
  eventId: string;
  timestamp: string;
  actor: string;
  command: string;
  reason: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  guardRule: string;
  approvalState: "none" | "pending" | "approved" | "rejected";
}

export interface ExplainSafetyResult {
  allowed: boolean;
  reason: string;
  eventId: string;
  matchedRule?: string;
  severity?: string;
  matchedToken?: string;
  suggestedAction?: string;
}

/**
 * Remove comments from SQL string
 */
export function stripSqlComments(sql: string): string {
  let noComments = sql.replace(/\/\*[\s\S]*?\*\//g, " ");
  noComments = noComments.split("\n").map(line => line.replace(/--.*$/, "")).join(" ");
  return noComments.trim();
}

/**
 * Tokenize shell command
 */
export function tokenizeShellCommand(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let insideQuotes = false;
  let quoteChar = "";

  for (let i = 0; i < commandLine.length; i++) {
    const char = commandLine[i];
    if (char === '"' || char === "'") {
      if (insideQuotes && char === quoteChar) {
        insideQuotes = false;
      } else if (!insideQuotes) {
        insideQuotes = true;
        quoteChar = char;
      } else {
        current += char;
      }
    } else if (char === " " && !insideQuotes) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Parse path safely and check for traversals/symlinks
 */
export function isPathProtected(targetPath: string): boolean {
  try {
    if (!targetPath) return false;
    const normalizedTarget = path.resolve(targetPath.replace(/[/\\]/g, path.sep)).toLowerCase();
    const targetBasename = path.basename(normalizedTarget);

    const protectedFileBasenames = new Set([
      "constitution.md",
      "role.md",
      "agents.md",
      ".env",
      ".env.local",
      "package.json",
      "pnpm-lock.yaml"
    ]);

    if (protectedFileBasenames.has(targetBasename)) {
      return true;
    }

    const rootDir = path.resolve(process.cwd(), "..");

    for (const rule of PROTECTED_PATHS) {
      const normalizedRulePattern1 = path.resolve(rule.pattern.replace(/[/\\]/g, path.sep)).toLowerCase();
      const normalizedRulePattern2 = path.resolve(rootDir, rule.pattern.replace(/[/\\]/g, path.sep)).toLowerCase();
      
      const patterns = [normalizedRulePattern1, normalizedRulePattern2];
      for (const pattern of patterns) {
        if (normalizedTarget === pattern || 
            normalizedTarget.startsWith(pattern + path.sep) ||
            pattern.startsWith(normalizedTarget + path.sep)) {
          return true;
        }
      }
    }
  } catch (err) {
    return true;
  }
  return false;
}

/**
 * Check if SQL is destructive
 */
export function checkSqlDestructiveness(sql: string): { destructive: boolean; reason: string; matchedToken?: string; matchedRule?: string; suggestedAction?: string } {
  try {
    if (!sql) return { destructive: false, reason: "" };
    const cleanSql = stripSqlComments(sql);
    const statements = cleanSql.split(";").map(s => s.trim()).filter(s => s.length > 0);

    for (const stmt of statements) {
      const tokens = stmt.split(/\s+/).map(t => t.toUpperCase());
      const firstToken = tokens[0];

      if (FORBIDDEN_SQL_STATEMENTS.has(firstToken)) {
        return { 
          destructive: true, 
          reason: `Forbidden SQL statement keyword: ${firstToken}`,
          matchedToken: firstToken,
          matchedRule: "FORBIDDEN_SQL",
          suggestedAction: "Use migration instead."
        };
      }

      if (firstToken === "DELETE") {
        const hasWhere = tokens.includes("WHERE");
        if (!hasWhere) {
          return { 
            destructive: true, 
            reason: "DELETE statement missing WHERE clause",
            matchedToken: "DELETE",
            matchedRule: "FORBIDDEN_SQL",
            suggestedAction: "Provide a specific WHERE clause to delete specific rows."
          };
        }
        const whereIdx = tokens.indexOf("WHERE");
        const afterWhere = tokens.slice(whereIdx + 1).join("").replace(/\s+/g, "");
        if (afterWhere === "1=1" || afterWhere === "TRUE") {
          return { 
            destructive: true, 
            reason: "DELETE statement has trivial WHERE clause bypass (1=1)",
            matchedToken: "WHERE " + tokens.slice(whereIdx + 1).join(" "),
            matchedRule: "FORBIDDEN_SQL",
            suggestedAction: "Do not bypass WHERE clause restrictions with 1=1."
          };
        }
      }

      if (firstToken === "UPDATE") {
        const hasWhere = tokens.includes("WHERE");
        if (!hasWhere) {
          return { 
            destructive: true, 
            reason: "UPDATE statement missing WHERE clause",
            matchedToken: "UPDATE",
            matchedRule: "FORBIDDEN_SQL",
            suggestedAction: "Provide a specific WHERE clause to update specific rows."
          };
        }
        const whereIdx = tokens.indexOf("WHERE");
        const afterWhere = tokens.slice(whereIdx + 1).join("").replace(/\s+/g, "");
        if (afterWhere === "1=1" || afterWhere === "TRUE") {
          return { 
            destructive: true, 
            reason: "UPDATE statement has trivial WHERE clause bypass (1=1)",
            matchedToken: "WHERE " + tokens.slice(whereIdx + 1).join(" "),
            matchedRule: "FORBIDDEN_SQL",
            suggestedAction: "Do not bypass WHERE clause restrictions with 1=1."
          };
        }
      }
    }
  } catch (err) {
    throw err;
  }

  return { destructive: false, reason: "" };
}

/**
 * Check if command is destructive
 */
export function checkCommandDestructiveness(commandLine: string): { destructive: boolean; reason: string; matchedToken?: string; matchedRule?: string; suggestedAction?: string } {
  try {
    if (!commandLine) return { destructive: false, reason: "" };
    const tokens = tokenizeShellCommand(commandLine);
    if (tokens.length === 0) return { destructive: false, reason: "" };

    const firstToken = tokens[0].toLowerCase();
    const cmdName = path.basename(firstToken).replace(/\.exe$/i, "");

    // Check argv command name
    if (FORBIDDEN_COMMANDS.has(cmdName)) {
      return { 
        destructive: true, 
        reason: `Forbidden shell command/alias: ${cmdName}`,
        matchedToken: cmdName,
        matchedRule: "FORBIDDEN_COMMAND",
        suggestedAction: "Use allowed standard command execution instead."
      };
    }

    // Check nested shell cmd / powershell invocations
    const shellExecutables = new Set(["powershell", "pwsh", "cmd", "powershell.exe", "pwsh.exe", "cmd.exe"]);
    if (shellExecutables.has(cmdName)) {
      for (let i = 1; i < tokens.length; i++) {
        const token = tokens[i];
        const nextToken = tokens[i + 1];
        
        // Detect powershell -Command and cmd /c bypasses
        if ((token.toLowerCase() === "-command" || token.toLowerCase() === "-c" || token.toLowerCase() === "/c") && nextToken) {
          const nestedCheck = checkCommandDestructiveness(nextToken);
          if (nestedCheck.destructive) {
            return {
              destructive: true,
              reason: `Nested command bypass detected: ${nestedCheck.reason}`,
              matchedToken: nestedCheck.matchedToken,
              matchedRule: nestedCheck.matchedRule,
              suggestedAction: nestedCheck.suggestedAction
            };
          }
        }
      }
    }

    // Scan whole argv for protected paths
    for (const token of tokens) {
      if (isPathProtected(token)) {
        return { 
          destructive: true, 
          reason: `Command targets protected path: ${token}`,
          matchedToken: token,
          matchedRule: "PROTECTED_PATH",
          suggestedAction: "Modify target path to write within scratch directory."
        };
      }
    }
  } catch (err) {
    throw err;
  }

  return { destructive: false, reason: "" };
}

export let auditLogs: AuditEventPayload[] = [];
export function recordAuditTrail(payload: AuditEventPayload) {
  auditLogs.push(payload);
}

export interface EvaluateActionInput {
  actor: string;
  actionType: "shell" | "sql" | "file";
  payload: string;
  mode: OperationalMode;
  approvedByBoard: boolean;
  emergencyOverrideToken?: string;
  timeoutMs?: number;
}

/**
 * Pre-execution Action Safety Evaluator (Core System Guard Logic)
 */
export async function evaluateActionSafety(input: EvaluateActionInput): Promise<ExplainSafetyResult> {
  const eventId = `evt-${Math.random().toString(36).substring(2, 11)}`;
  const timestamp = new Date().toISOString();

  const timeoutMs = input.timeoutMs ?? 2000;
  const timeoutPromise = new Promise<ExplainSafetyResult>(
    (_, reject) => setTimeout(() => reject(new Error("System Guard check timed out")), timeoutMs)
  );

  const evaluationPromise = (async () => {
    await new Promise(resolve => setTimeout(resolve, 5));

    if (input.payload === null || input.payload === undefined) {
      throw new Error("System Guard internal exception: Payload is null or undefined");
    }

    try {
      let riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" = "LOW";
      let destructive = false;
      let reason = "";
      let matchedRule: string | undefined;
      let matchedToken: string | undefined;
      let suggestedAction: string | undefined;

      if (input.actionType === "shell") {
        const cmdCheck = checkCommandDestructiveness(input.payload);
        destructive = cmdCheck.destructive;
        reason = cmdCheck.reason;
        matchedRule = cmdCheck.matchedRule;
        matchedToken = cmdCheck.matchedToken;
        suggestedAction = cmdCheck.suggestedAction;
        riskLevel = destructive ? "CRITICAL" : "MEDIUM";
      } else if (input.actionType === "sql") {
        const sqlCheck = checkSqlDestructiveness(input.payload);
        destructive = sqlCheck.destructive;
        reason = sqlCheck.reason;
        matchedRule = sqlCheck.matchedRule;
        matchedToken = sqlCheck.matchedToken;
        suggestedAction = sqlCheck.suggestedAction;
        riskLevel = destructive ? "CRITICAL" : "MEDIUM";
      } else if (input.actionType === "file") {
        const pathProtected = isPathProtected(input.payload);
        if (pathProtected) {
          destructive = true;
          reason = `Protected file path access or deletion: ${input.payload}`;
          matchedRule = "PROTECTED_PATH";
          matchedToken = input.payload;
          suggestedAction = "Modify target path to write within scratch directory.";
          riskLevel = "CRITICAL";
        }
      }

      if (destructive && isPathProtected(input.payload)) {
        riskLevel = "CRITICAL";
        reason = `Absolute Protected Path violation: ${reason}`;
      }

      let requiresApproval = false;
      if (riskLevel === "CRITICAL" || (riskLevel as string) === "HIGH") {
        requiresApproval = true;
      }

      // Read Emergency Override Token from environment variable
      const envToken = process.env.NEXORA_EMERGENCY_OVERRIDE_TOKEN;
      let overrideActive = false;
      if (input.emergencyOverrideToken && envToken && input.emergencyOverrideToken === envToken) {
        overrideActive = true;
      }

      // Production Mode must always DENY override
      if (input.mode === "Production") {
        overrideActive = false;
      }

      let allowed = true;
      if (riskLevel === "CRITICAL") {
        if (input.mode === "Maintenance" && overrideActive) {
          allowed = true;
        } else {
          allowed = false;
          reason = `Critical destructive action blocked: ${reason}`;
        }
      } else if (requiresApproval) {
        if (!input.approvedByBoard) {
          allowed = false;
          reason = `Action requires Human Approval: ${reason}`;
        }
      }

      if (input.mode === "Production" && riskLevel === "CRITICAL" && !overrideActive) {
        allowed = false;
        reason = `Production Mode restriction: Destructive actions strictly blocked.`;
      }

      recordAuditTrail({
        eventId,
        timestamp,
        actor: input.actor,
        command: input.payload,
        reason: allowed ? "Allowed" : reason,
        riskLevel,
        guardRule: destructive ? (matchedRule || "Destructive Rule Matched") : "Normal Route",
        approvalState: input.approvedByBoard ? "approved" : (requiresApproval ? "pending" : "none")
      });

      const output: ExplainSafetyResult = { allowed, reason, eventId };
      if (!allowed && destructive) {
        output.matchedRule = matchedRule;
        output.severity = riskLevel;
        output.matchedToken = matchedToken;
        output.suggestedAction = suggestedAction;
      }
      return output;
    } catch (err) {
      return { 
        allowed: false, 
        reason: `System Guard internal exception: ${err instanceof Error ? err.message : String(err)}`,
        eventId
      };
    }
  })();

  try {
    const result = await Promise.race([evaluationPromise, timeoutPromise]);
    return result;
  } catch (err) {
    const finalReason = `System Guard interception (Fail-Closed): ${err instanceof Error ? err.message : String(err)}`;
    recordAuditTrail({
      eventId,
      timestamp,
      actor: input.actor,
      command: input.payload,
      reason: finalReason,
      riskLevel: "CRITICAL",
      guardRule: "FAIL_CLOSED",
      approvalState: "none"
    });
    return {
      allowed: false,
      reason: finalReason,
      eventId,
      matchedRule: "FAIL_CLOSED",
      severity: "CRITICAL",
      suggestedAction: "Investigate System Guard service logs and health."
    };
  }
}
