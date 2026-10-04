import { api } from "./client";
import type { ToolRiskLevel, ToolTrustStatus } from "@paperclipai/shared";

export type { ToolRiskLevel, ToolTrustStatus };
export type TrustRegistryType = "tool" | "mcp" | "plugin";

export interface TrustRegistryEntry {
  id: string;
  type: TrustRegistryType;
  name: string;
  provider: string | null;
  version: string | null;
  source: string;
  sourceUrl: string | null;
  trustStatus: ToolTrustStatus;
  riskLevel: ToolRiskLevel | null;
  requestedScopes: string[];
  approvedScopes: string[];
  signature: string | null;
  signatureVerified: boolean;
  enabled: boolean;
  reviewedAt: string | null;
  reviewedBy: string | null;
  companyId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ToolTrustRegistryListResponse {
  entries: TrustRegistryEntry[];
}

export interface ToolTrustRegistryDetailResponse {
  entry: TrustRegistryEntry;
}

export interface ToolTrustRegistryQueryParams {
  type?: TrustRegistryType;
  trustStatus?: ToolTrustStatus;
  enabled?: boolean;
}

export const toolTrustApi = {
  list: (params?: ToolTrustRegistryQueryParams) => {
    const searchParams = new URLSearchParams();
    if (params?.type) searchParams.set("type", params.type);
    if (params?.trustStatus) searchParams.set("trustStatus", params.trustStatus);
    if (params?.enabled !== undefined) searchParams.set("enabled", String(params.enabled));
    const query = searchParams.toString();
    return api.get<ToolTrustRegistryListResponse>(`/tools/trust-registry${query ? `?${query}` : ""}`);
  },
  get: (id: string) =>
    api.get<ToolTrustRegistryDetailResponse>(`/tools/trust-registry/${encodeURIComponent(id)}`),
};
