export interface PathGuardRule {
  pattern: string;
  description: string;
}

export const PROTECTED_PATHS: PathGuardRule[] = [
  { pattern: ".paperclip/instances/default/db", description: "Production Database Directory" },
  { pattern: ".paperclip/instances/default/data/backups", description: "Database Backups Directory" },
  { pattern: ".paperclip/instances/default/companies", description: "Company Instances Directory" },
  { pattern: "CONSTITUTION.md", description: "System Constitution File" },
  { pattern: "ROLE.md", description: "Agent Role Definitions" },
  { pattern: "AGENTS.md", description: "Agent Manifests File" },
  { pattern: ".env", description: "Environment Configuration File" },
  { pattern: ".env.local", description: "Local Environment Configuration File" },
  { pattern: "package.json", description: "Node Package Metadata" },
  { pattern: "pnpm-lock.yaml", description: "Package Lock File" },
  { pattern: "drizzle", description: "Drizzle Directory" },
  { pattern: "migrations", description: "Migrations Directory" },
  { pattern: "packages/db", description: "Database Packages Directory" }
];

export const FORBIDDEN_COMMANDS = new Set([
  "rm",
  "rmdir",
  "del",
  "erase",
  "rd",
  "remove-item",
  "remove-itemproperty",
  "ri"
]);

export const FORBIDDEN_SQL_STATEMENTS = new Set([
  "DROP",
  "TRUNCATE",
  "ALTER",
  "VACUUM",
  "REINDEX",
  "CLUSTER"
]);

export type OperationalMode = "Development" | "Maintenance" | "Production";

export interface ModeRule {
  allowDdl: boolean;
  allowDestructiveDml: boolean;
  requiresApprovalForDdl: boolean;
  requiresApprovalForDestructiveDml: boolean;
}

export const MODE_RULES: Record<OperationalMode, ModeRule> = {
  Development: {
    allowDdl: true,
    allowDestructiveDml: false,
    requiresApprovalForDdl: false,
    requiresApprovalForDestructiveDml: true
  },
  Maintenance: {
    allowDdl: true,
    allowDestructiveDml: false,
    requiresApprovalForDdl: true,
    requiresApprovalForDestructiveDml: false
  },
  Production: {
    allowDdl: false,
    allowDestructiveDml: false,
    requiresApprovalForDdl: false,
    requiresApprovalForDestructiveDml: false
  }
};
