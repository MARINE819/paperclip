import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { aiOfficeApi } from "@/api/aiOffice";
import { agentsApi, type OrgNode } from "@/api/agents";
import { heartbeatsApi } from "@/api/heartbeats";
import { approvalsApi } from "@/api/approvals";
import { costsApi } from "@/api/costs";
import { describeApiError } from "@/api/client";
import { useCompany } from "@/context/CompanyContext";
import { relativeTime } from "@/lib/utils";
import { AgentStatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AIOfficeControlTower, deriveAgentCondition } from "@/components/AIOfficeControlTower";
import { VoiceCommandBar } from "@/components/VoiceCommandBar";

function statusBadgeVariant(status: string): "default" | "secondary" | "destructive" {
  if (["running", "healthy", "ok"].includes(status)) return "default";
  if (["recovering"].includes(status)) return "secondary";
  return "destructive";
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <span className="text-xs text-muted-foreground whitespace-nowrap">
      {label}: <span className="text-foreground">{value}</span>
    </span>
  );
}

function OrgHierarchyNode({
  node,
  depth,
  liveRunByAgentId,
}: {
  node: OrgNode;
  depth: number;
  liveRunByAgentId: Map<string, { status: string }>;
}) {
  const hasLiveRun = liveRunByAgentId.has(node.id);
  return (
    <div>
      <div
        className="flex items-center gap-2 py-1 text-sm"
        style={{ paddingLeft: `${depth * 16}px` }}
      >
        <span className="truncate">{node.name}</span>
        <span className="text-xs text-muted-foreground">{node.role}</span>
        <AgentStatusBadge status={node.status} />
        {hasLiveRun ? (
          <span className="text-xs text-blue-600 dark:text-blue-400">Working now</span>
        ) : null}
      </div>
      {node.reports.map((child) => (
        <OrgHierarchyNode key={child.id} node={child} depth={depth + 1} liveRunByAgentId={liveRunByAgentId} />
      ))}
    </div>
  );
}

export function AIOfficeStatus() {
  const { selectedCompanyId } = useCompany();

  const statusQuery = useQuery({
    queryKey: ["ai-office-status"],
    queryFn: aiOfficeApi.getStatus,
    refetchInterval: 15_000,
  });

  const agentsQuery = useQuery({
    queryKey: ["ai-office-agents", selectedCompanyId],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const liveRunsQuery = useQuery({
    queryKey: ["ai-office-live-runs", selectedCompanyId],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const orgUnitsQuery = useQuery({
    queryKey: ["ai-office-org-units", selectedCompanyId],
    queryFn: () => agentsApi.orgUnitsStatus(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const pendingApprovalsQuery = useQuery({
    queryKey: ["ai-office-approvals-pending", selectedCompanyId],
    queryFn: () => approvalsApi.list(selectedCompanyId!, "pending"),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const revisionRequestedApprovalsQuery = useQuery({
    queryKey: ["ai-office-approvals-revision-requested", selectedCompanyId],
    queryFn: () => approvalsApi.list(selectedCompanyId!, "revision_requested"),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const orgQuery = useQuery({
    queryKey: ["ai-office-org", selectedCompanyId],
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const usageByAgentModelQuery = useQuery({
    queryKey: ["ai-office-usage-by-agent-model", selectedCompanyId],
    queryFn: () => costsApi.byAgentModel(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const usageByProviderQuery = useQuery({
    queryKey: ["ai-office-usage-by-provider", selectedCompanyId],
    queryFn: () => costsApi.byProvider(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const quotaWindowsQuery = useQuery({
    queryKey: ["ai-office-quota-windows", selectedCompanyId],
    queryFn: () => costsApi.quotaWindows(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const liveRunByAgentId = new Map(
    (liveRunsQuery.data ?? []).map((run) => [run.agentId, run]),
  );

  const agentNameById = new Map((agentsQuery.data ?? []).map((agent) => [agent.id, agent.name]));
  const agentsById = new Map((agentsQuery.data ?? []).map((agent) => [agent.id, agent]));
  const orgUnitNameById = new Map((orgUnitsQuery.data ?? []).map((unit) => [unit.orgUnitId, unit.name]));

  const pendingApprovalsLoading = pendingApprovalsQuery.isLoading || revisionRequestedApprovalsQuery.isLoading;
  const pendingApprovalsError = pendingApprovalsQuery.error ?? revisionRequestedApprovalsQuery.error;
  const pendingApprovals = [
    ...(pendingApprovalsQuery.data ?? []),
    ...(revisionRequestedApprovalsQuery.data ?? []),
  ];
  const pendingApprovalByAgentId = new Map(
    pendingApprovals
      .filter((approval) => !!approval.requestedByAgentId)
      .map((approval) => [approval.requestedByAgentId as string, approval]),
  );

  const providerCostTotals = new Map<string, number>();
  for (const row of usageByProviderQuery.data ?? []) {
    providerCostTotals.set(row.provider, (providerCostTotals.get(row.provider) ?? 0) + row.costCents);
  }

  const now = Date.now();
  const errorOrOfflineAgents = (agentsQuery.data ?? []).filter(
    (agent) => deriveAgentCondition(agent, liveRunByAgentId.has(agent.id), now) !== null,
  );

  if (statusQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading AI Office status...</div>;
  }

  if (statusQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {describeApiError(statusQuery.error, "Failed to load AI Office status.")}
      </div>
    );
  }

  const status = statusQuery.data;
  if (!status) {
    return <div className="text-sm text-muted-foreground">No status data available.</div>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">AI Office Status</h1>
        <span className="text-xs text-muted-foreground">
          Last updated {new Date(status.timestamp).toLocaleTimeString()}
        </span>
      </div>
      {selectedCompanyId ? <VoiceCommandBar companyId={selectedCompanyId} /> : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-sm">
              Supervisor
              <Badge variant={statusBadgeVariant(status.supervisor.status)}>
                {status.supervisor.status}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <div>PID: {status.supervisor.pid ?? "—"}</div>
            <div>Uptime: {status.supervisor.uptimeSeconds}s</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-sm">
              Server
              <Badge variant={statusBadgeVariant(status.server.status)}>
                {status.server.status}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <div>Version: {status.server.version}</div>
            <div>
              Listening: {status.server.listenHost}:{status.server.listenPort}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-sm">
              Database
              <Badge variant={statusBadgeVariant(status.database.status)}>
                {status.database.status}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <div>Mode: {status.database.mode}</div>
            <div>Port: {status.database.port}</div>
            <div>Active connections: {status.database.activeConnections}</div>
            <div className="truncate">Connection: {status.database.connectionUrlSanitized}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-sm">
              Backup
              <Badge variant={statusBadgeVariant(status.backup.status)}>
                {status.backup.status}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <div>Enabled: {status.backup.enabled ? "yes" : "no"}</div>
            <div>Latest backup: {status.backup.latestBackupName ?? "—"}</div>
            <div>Latest backup time: {status.backup.latestBackupTime ?? "—"}</div>
            <div>Max age: {status.backup.databaseBackupMaxAgeHours}h</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Agents</CardTitle>
        </CardHeader>
        <CardContent>
          {agentsQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading agents...</div>
          ) : agentsQuery.error ? (
            <div className="text-sm text-destructive">
              {describeApiError(agentsQuery.error, "Failed to load agents.")}
            </div>
          ) : !agentsQuery.data || agentsQuery.data.length === 0 ? (
            <div className="text-sm text-muted-foreground">No agents found.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {agentsQuery.data.map((agent) => {
                const liveRun = liveRunByAgentId.get(agent.id);
                return (
                  <div key={agent.id} className="flex flex-col gap-1 border-t pt-2">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="truncate font-medium">{agent.name}</span>
                      <AgentStatusBadge status={agent.status} />
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                      <Field label="Current Task" value={liveRun ? `Running (${liveRun.status})` : "—"} />
                      <Field
                        label="Last Activity"
                        value={agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "—"}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Departments</CardTitle>
        </CardHeader>
        <CardContent>
          {orgUnitsQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading departments...</div>
          ) : orgUnitsQuery.error ? (
            <div className="text-sm text-destructive">
              {describeApiError(orgUnitsQuery.error, "Failed to load departments.")}
            </div>
          ) : !orgUnitsQuery.data || orgUnitsQuery.data.length === 0 ? (
            <div className="text-sm text-muted-foreground">No departments configured.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {orgUnitsQuery.data.map((unit) => (
                <div key={unit.orgUnitId} className="flex flex-col gap-1 border-t pt-2">
                  <span className="truncate text-sm font-medium">{unit.name}</span>
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    <Field label="Agents" value={unit.agentCount} />
                    <Field label="Active" value={unit.activeCount} />
                    <Field label="Running" value={unit.runningCount} />
                    <Field label="Error" value={unit.errorCount} />
                    <Field label="Current Tasks" value={unit.currentTaskCount} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Pending Approvals</CardTitle>
        </CardHeader>
        <CardContent>
          {pendingApprovalsLoading ? (
            <div className="text-sm text-muted-foreground">Loading approvals...</div>
          ) : pendingApprovalsError ? (
            <div className="text-sm text-destructive">
              {describeApiError(pendingApprovalsError, "Failed to load approvals.")}
            </div>
          ) : pendingApprovals.length === 0 ? (
            <div className="text-sm text-muted-foreground">No pending approvals.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {pendingApprovals.map((approval) => {
                const relatedIssue =
                  typeof approval.payload.issueIdentifier === "string"
                    ? approval.payload.issueIdentifier
                    : "—";
                const requestingAgent = approval.requestedByAgentId
                  ? agentNameById.get(approval.requestedByAgentId) ?? "—"
                  : "—";
                return (
                  <div key={approval.id} className="flex flex-col gap-1 border-t pt-2">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="truncate font-medium">{approval.id.slice(0, 8)}</span>
                      <span className="truncate text-muted-foreground">{approval.type}</span>
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                      <Field label="Status" value={approval.status} />
                      <Field label="Created" value={relativeTime(approval.createdAt)} />
                      <Field label="Related Issue" value={relatedIssue} />
                      <Field label="Requesting Agent" value={requestingAgent} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Error / Offline Agents</CardTitle>
        </CardHeader>
        <CardContent>
          {agentsQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading agents...</div>
          ) : agentsQuery.error ? (
            <div className="text-sm text-destructive">
              {describeApiError(agentsQuery.error, "Failed to load agents.")}
            </div>
          ) : errorOrOfflineAgents.length === 0 ? (
            <div className="text-sm text-muted-foreground">No error or offline agents.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {errorOrOfflineAgents.map((agent) => (
                <div key={agent.id} className="flex flex-col gap-1 border-t pt-2">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="truncate font-medium">{agent.name}</span>
                    <Badge variant="destructive">{agent.status === "error" ? "error" : "offline"}</Badge>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    <Field
                      label="Last Activity"
                      value={agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "—"}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Active Runs</CardTitle>
        </CardHeader>
        <CardContent>
          {liveRunsQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading active runs...</div>
          ) : liveRunsQuery.error ? (
            <div className="text-sm text-destructive">
              {describeApiError(liveRunsQuery.error, "Failed to load active runs.")}
            </div>
          ) : !liveRunsQuery.data || liveRunsQuery.data.length === 0 ? (
            <div className="text-sm text-muted-foreground">No active runs.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {liveRunsQuery.data.map((run) => (
                <div key={run.id} className="flex flex-wrap items-center gap-2 border-t pt-2 text-sm">
                  <span className="truncate font-medium">{run.agentName}</span>
                  <Badge variant={run.status === "running" ? "default" : "secondary"}>{run.status}</Badge>
                  <span className="truncate text-muted-foreground">{run.issueId ?? "—"}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Workflow / Command Chain</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {orgQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading hierarchy...</div>
          ) : orgQuery.error ? (
            <div className="text-sm text-destructive">
              {describeApiError(orgQuery.error, "Failed to load hierarchy.")}
            </div>
          ) : !orgQuery.data || orgQuery.data.length === 0 ? (
            <div className="text-sm text-muted-foreground">No hierarchy data.</div>
          ) : (
            <div className="flex flex-col">
              {orgQuery.data.map((root) => (
                <OrgHierarchyNode key={root.id} node={root} depth={0} liveRunByAgentId={liveRunByAgentId} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Visual Control Tower</CardTitle>
        </CardHeader>
        <CardContent>
          {orgQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading hierarchy...</div>
          ) : orgQuery.error ? (
            <div className="text-sm text-destructive">
              {describeApiError(orgQuery.error, "Failed to load hierarchy.")}
            </div>
          ) : (
            <AIOfficeControlTower
              orgTree={orgQuery.data ?? []}
              agentsById={agentsById}
              orgUnitNameById={orgUnitNameById}
              liveRunByAgentId={liveRunByAgentId}
              pendingApprovalByAgentId={pendingApprovalByAgentId}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Model / Provider Usage</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div>
            <div className="mb-2 text-xs font-medium text-muted-foreground">Usage &amp; Cost</div>
            {usageByAgentModelQuery.isLoading || usageByProviderQuery.isLoading ? (
              <div className="text-sm text-muted-foreground">Loading usage...</div>
            ) : usageByAgentModelQuery.error || usageByProviderQuery.error ? (
              <div className="text-sm text-destructive">
                {describeApiError(usageByAgentModelQuery.error ?? usageByProviderQuery.error, "Failed to load usage.")}
              </div>
            ) : !usageByAgentModelQuery.data || usageByAgentModelQuery.data.length === 0 ? (
              <div className="text-sm text-muted-foreground">No usage recorded.</div>
            ) : (
              <div className="flex flex-col gap-2">
                {providerCostTotals.size > 0 ? (
                  <div className="flex flex-wrap gap-x-3 gap-y-1 pb-1">
                    {Array.from(providerCostTotals.entries()).map(([provider, costCents]) => (
                      <Field key={provider} label={`Total (${provider})`} value={`$${(costCents / 100).toFixed(2)}`} />
                    ))}
                  </div>
                ) : null}
                {usageByAgentModelQuery.data.map((row, index) => {
                  const totalTokens = row.inputTokens + row.cachedInputTokens + row.outputTokens;
                  return (
                    <div
                      key={`${row.agentId}-${row.model}-${index}`}
                      className="flex flex-col gap-1 border-t pt-2"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="truncate font-medium">{row.agentName ?? "—"}</span>
                        <span className="truncate text-muted-foreground">{row.model}</span>
                        <Badge variant="secondary">{row.provider}</Badge>
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        <Field label="Input Tokens" value={row.inputTokens} />
                        <Field label="Cached Input Tokens" value={row.cachedInputTokens} />
                        <Field label="Output Tokens" value={row.outputTokens} />
                        <Field label="Total Usage" value={totalTokens} />
                        <Field label="Cost" value={`$${(row.costCents / 100).toFixed(2)}`} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <div className="mb-2 text-xs font-medium text-muted-foreground">Quota / Rate Limits</div>
            {quotaWindowsQuery.isLoading ? (
              <div className="text-sm text-muted-foreground">Loading quota...</div>
            ) : quotaWindowsQuery.error ? (
              <div className="text-sm text-destructive">
                {describeApiError(quotaWindowsQuery.error, "Failed to load quota.")}
              </div>
            ) : !quotaWindowsQuery.data || quotaWindowsQuery.data.length === 0 ? (
              <div className="text-sm text-muted-foreground">No quota data available.</div>
            ) : (
              <div className="flex flex-col gap-2">
                {quotaWindowsQuery.data.map((result) =>
                  !result.ok ? (
                    <div key={result.provider} className="flex flex-col gap-1 border-t pt-2">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <Badge variant="secondary">{result.provider}</Badge>
                        <span className="text-destructive">{result.error ?? "Quota unavailable"}</span>
                      </div>
                    </div>
                  ) : result.windows.length === 0 ? (
                    <div key={result.provider} className="flex flex-col gap-1 border-t pt-2">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <Badge variant="secondary">{result.provider}</Badge>
                        <span className="text-muted-foreground">No quota windows reported.</span>
                      </div>
                    </div>
                  ) : (
                    result.windows.map((window, index) => (
                      <div
                        key={`${result.provider}-${window.label}-${index}`}
                        className="flex flex-col gap-1 border-t pt-2"
                      >
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <Badge variant="secondary">{result.provider}</Badge>
                          <span className="truncate font-medium">{window.label}</span>
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-1">
                          <Field
                            label="Quota / Remaining"
                            value={window.usedPercent === null ? "unknown" : `${window.usedPercent}% used`}
                          />
                          <Field label="Reset" value={window.resetsAt ? relativeTime(window.resetsAt) : "—"} />
                          {window.valueLabel ? <Field label="Value" value={window.valueLabel} /> : null}
                        </div>
                      </div>
                    ))
                  ),
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
