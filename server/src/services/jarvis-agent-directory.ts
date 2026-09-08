import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import type { JarvisSelectableAgent } from "./jarvis-agent-selector.js";

/**
 * Company-scoped agent lookups for the JARVIS Delegation Loop integration
 * layer. Mirrors the existing query shape already used for assignment
 * eligibility (see listCompanyAgents/getAgent in
 * server/src/services/agent-assignability.ts:70-95), extended with the
 * adapterType/capabilities columns jarvis-agent-selector.ts's
 * JarvisSelectableAgent needs. This module only reads; it never creates,
 * updates, or deletes an agent record.
 */

const AGENT_DELEGATION_COLUMNS = {
  id: agents.id,
  companyId: agents.companyId,
  name: agents.name,
  status: agents.status,
  reportsTo: agents.reportsTo,
  adapterType: agents.adapterType,
  capabilities: agents.capabilities,
};

interface AgentDelegationRow {
  id: string;
  companyId: string;
  name: string;
  status: string;
  reportsTo: string | null;
  adapterType: string;
  capabilities: string | null;
}

function toSelectableAgent(row: AgentDelegationRow): JarvisSelectableAgent {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    status: row.status,
    reportsTo: row.reportsTo,
    adapterType: row.adapterType,
    capabilities: row.capabilities,
  };
}

export async function listCompanyAgentsForDelegation(db: Db, companyId: string): Promise<JarvisSelectableAgent[]> {
  const rows = await db.select(AGENT_DELEGATION_COLUMNS).from(agents).where(eq(agents.companyId, companyId));
  return rows.map(toSelectableAgent);
}

export async function getAgentByIdForDelegation(db: Db, agentId: string): Promise<JarvisSelectableAgent | null> {
  const rows = await db.select(AGENT_DELEGATION_COLUMNS).from(agents).where(eq(agents.id, agentId)).limit(1);
  return rows[0] ? toSelectableAgent(rows[0]) : null;
}
