import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "antigravity_local";
export const label = "Antigravity CLI (Local)";

export const DEFAULT_ANTIGRAVITY_LOCAL_MODEL = "auto";

export const models = [
  { id: DEFAULT_ANTIGRAVITY_LOCAL_MODEL, label: "Auto" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [];

export const agentConfigurationDoc = `# antigravity_local agent configuration

Adapter: antigravity_local

Use when:
- You want to securely fall back to Antigravity CLI for text reasoning.

Core fields:
- command (string, optional): absolute path to agy.exe. Defaults to C:\\Users\\Nexora\\AppData\\Local\\agy\\bin\\agy.exe
- runtimeDir (string, optional): workspace isolation directory.
`;
