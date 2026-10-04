import { api } from "./client";

export type IncidentSeverity = "low" | "medium" | "high" | "critical";
export type IncidentStatus = "open" | "recovering" | "resolved";
export type RootCauseStatus = "known" | "unknown" | "investigating";

export interface RuntimeIncidentSummary {
  id: string;
  code: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  affectedComponents: string[];
  detectedAt: string;
  lastObservedAt: string;
  resolvedAt: string | null;
  occurrenceCount: number;
  recoveryAttempted: boolean;
  recoveryResult: string | null;
  rootCauseStatus: RootCauseStatus;
  failureMemoryCandidate: boolean;
  // Optional forward-compatible fields
  fingerprint?: string | null;
  evidence?: unknown[] | null;
  failureMemoryDraft?: Record<string, unknown> | null;
}

export interface InstanceIncidentsResponse {
  open: RuntimeIncidentSummary[];
  resolved: RuntimeIncidentSummary[];
}

export const incidentsApi = {
  list: (params?: { instanceId?: string }) => {
    const q = new URLSearchParams();
    if (params?.instanceId) q.set("instanceId", params.instanceId);
    const qs = q.toString();
    return api.get<InstanceIncidentsResponse>(`/instance/incidents${qs ? `?${qs}` : ""}`);
  },
};
