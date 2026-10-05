import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent, Issue } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { heartbeatsApi, type LiveRunForIssue } from "@/api/heartbeats";
import { approvalsApi } from "@/api/approvals";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { cn, relativeTime } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

/**
 * Dashboard's own operational classification — deliberately not imported
 * from AI Office's files (AIOfficeFloor.tsx / AIOfficeControlTower.tsx),
 * which own the seat-visualization concept. This is the same underlying
 * signal (agent status, live run, pending approval, heartbeat recency) but
 * kept as Dashboard's own small pure function so the two pages never share a
 * UI component or a presentation-layer type, only the raw data underneath.
 */
const OFFLINE_AFTER_MS = 30 * 60 * 1000;

export type AgentOpsCategory = "working" | "approval-waiting" | "blocked-error" | "offline" | "idle";

export function deriveAgentOpsCategory(
  agent: Pick<Agent, "status" | "lastHeartbeatAt">,
  hasLiveRun: boolean,
  hasPendingApproval: boolean,
  now: number,
): AgentOpsCategory {
  if (agent.status === "error") return "blocked-error";
  if (hasPendingApproval) return "approval-waiting";
  if (hasLiveRun) return "working";
  if (!agent.lastHeartbeatAt) return "offline";
  return now - new Date(agent.lastHeartbeatAt).getTime() > OFFLINE_AFTER_MS ? "offline" : "idle";
}

const OPS_CATEGORY_LABEL: Record<AgentOpsCategory, string> = {
  working: "업무 중",
  "approval-waiting": "승인 대기",
  "blocked-error": "오류/차단",
  offline: "오프라인",
  idle: "대기",
};

const OPS_CATEGORY_CLASS: Record<AgentOpsCategory, string> = {
  working: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  "approval-waiting": "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  "blocked-error": "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  offline: "border-border bg-muted text-muted-foreground",
  idle: "border-border bg-background text-muted-foreground",
};

export function OpsCategoryBadge({ category }: { category: AgentOpsCategory }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        OPS_CATEGORY_CLASS[category],
      )}
    >
      {OPS_CATEGORY_LABEL[category]}
    </span>
  );
}

export function taskSummaryFor(liveRun: LiveRunForIssue | undefined): string {
  if (!liveRun) return "현재 작업 없음";
  return liveRun.currentStatusMessage ?? liveRun.triggerDetail ?? liveRun.lastAssistantSnippet ?? "현재 작업 없음";
}

const OPEN_ISSUE_STATUSES = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);

export function currentIssueFor(agentId: string, issues: Issue[]): Issue | undefined {
  return issues
    .filter((issue) => issue.assigneeAgentId === agentId && OPEN_ISSUE_STATUSES.has(issue.status))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
}

export interface AgentOpsRow {
  agent: Agent;
  category: AgentOpsCategory;
  liveRun: LiveRunForIssue | undefined;
  currentIssue: Issue | undefined;
  hasPendingApproval: boolean;
}

export function buildAgentOpsRows(
  agents: Agent[],
  liveRuns: LiveRunForIssue[],
  pendingApprovalAgentIds: Set<string>,
  issues: Issue[],
  now: number,
): AgentOpsRow[] {
  const liveRunByAgentId = new Map(liveRuns.map((run) => [run.agentId, run]));
  return agents.map((agent) => {
    const liveRun = liveRunByAgentId.get(agent.id);
    const hasPendingApproval = pendingApprovalAgentIds.has(agent.id);
    return {
      agent,
      category: deriveAgentOpsCategory(agent, !!liveRun, hasPendingApproval, now),
      liveRun,
      currentIssue: currentIssueFor(agent.id, issues),
      hasPendingApproval,
    };
  });
}

function OpsStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-2 text-center">
      <div className="text-lg font-semibold">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

function issueLabel(issue: Issue | undefined): string {
  if (!issue) return "배정된 이슈 없음";
  const ref = issue.identifier ?? issue.id.slice(0, 8);
  return `${ref} · ${issue.title}`;
}

/**
 * The company's operational control room: every real agent, its real
 * current state, task, issue, approval and heartbeat — never a fabricated
 * value. Empty facts render as an explicit Korean "none" string rather than
 * a bare dash, per the no-silent-blank-space rule for this panel.
 */
export function AgentOperationsPanel({ companyId }: { companyId: string }) {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
    refetchInterval: 15_000,
  });
  const liveRunsQuery = useQuery({
    queryKey: queryKeys.liveRuns(companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
    enabled: !!companyId,
    refetchInterval: 15_000,
  });
  const pendingApprovalsQuery = useQuery({
    queryKey: queryKeys.approvals.list(companyId, "pending"),
    queryFn: () => approvalsApi.list(companyId, "pending"),
    enabled: !!companyId,
    refetchInterval: 15_000,
  });
  const issuesQuery = useQuery({
    queryKey: queryKeys.issues.list(companyId),
    queryFn: () => issuesApi.list(companyId),
    enabled: !!companyId,
  });

  const isLoading =
    agentsQuery.isLoading || liveRunsQuery.isLoading || pendingApprovalsQuery.isLoading || issuesQuery.isLoading;
  const isError = agentsQuery.isError || liveRunsQuery.isError || pendingApprovalsQuery.isError || issuesQuery.isError;

  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data]);
  const liveRuns = useMemo(() => liveRunsQuery.data ?? [], [liveRunsQuery.data]);
  const issues = useMemo(() => issuesQuery.data ?? [], [issuesQuery.data]);
  const pendingApprovalAgentIds = useMemo(
    () =>
      new Set(
        (pendingApprovalsQuery.data ?? [])
          .filter((approval) => !!approval.requestedByAgentId)
          .map((approval) => approval.requestedByAgentId as string),
      ),
    [pendingApprovalsQuery.data],
  );

  const rows = useMemo(() => {
    const now = Date.now();
    return buildAgentOpsRows(agents, liveRuns, pendingApprovalAgentIds, issues, now);
  }, [agents, liveRuns, pendingApprovalAgentIds, issues]);

  const counts = useMemo(() => {
    const c: Record<AgentOpsCategory, number> = {
      working: 0,
      "approval-waiting": 0,
      "blocked-error": 0,
      offline: 0,
      idle: 0,
    };
    for (const row of rows) c[row.category] += 1;
    return c;
  }, [rows]);

  const selectedRow = rows.find((row) => row.agent.id === selectedAgentId) ?? null;

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Agent 운영 현황</h3>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        <OpsStat label="전체" value={agents.length} />
        <OpsStat label="업무 중" value={counts.working} />
        <OpsStat label="대기" value={counts.idle} />
        <OpsStat label="승인 대기" value={counts["approval-waiting"]} />
        <OpsStat label="오류/차단" value={counts["blocked-error"]} />
        <OpsStat label="오프라인" value={counts.offline} />
      </div>

      {isLoading ? (
        <div className="rounded-xl border p-4 text-sm text-muted-foreground">불러오는 중...</div>
      ) : isError ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          Agent 운영 데이터 조회 실패
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border p-4 text-sm text-muted-foreground">등록된 Agent 없음</div>
      ) : (
        <Card className="overflow-hidden py-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/30 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">이름</th>
                  <th className="px-3 py-2 text-left font-medium">역할</th>
                  <th className="px-3 py-2 text-left font-medium">상태</th>
                  <th className="px-3 py-2 text-left font-medium">현재 업무</th>
                  <th className="px-3 py-2 text-left font-medium">현재 Issue</th>
                  <th className="px-3 py-2 text-left font-medium">마지막 하트비트</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr
                    key={row.agent.id}
                    data-testid="agent-ops-row"
                    className="cursor-pointer hover:bg-accent/50"
                    onClick={() => setSelectedAgentId(row.agent.id)}
                  >
                    <td className="px-3 py-2 font-medium">{row.agent.name}</td>
                    <td className="px-3 py-2 text-muted-foreground">{row.agent.title ?? row.agent.role}</td>
                    <td className="px-3 py-2">
                      <OpsCategoryBadge category={row.category} />
                    </td>
                    <td className="max-w-56 truncate px-3 py-2 text-muted-foreground">
                      {taskSummaryFor(row.liveRun)}
                    </td>
                    <td className="max-w-56 truncate px-3 py-2 text-muted-foreground">
                      {issueLabel(row.currentIssue)}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {row.agent.lastHeartbeatAt ? relativeTime(row.agent.lastHeartbeatAt) : "하트비트 기록 없음"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <AgentOpsDetailSheet
        row={selectedRow}
        onOpenChange={(open) => {
          if (!open) setSelectedAgentId(null);
        }}
      />
    </div>
  );
}

function AgentOpsDetailSheet({
  row,
  onOpenChange,
}: {
  row: AgentOpsRow | null;
  onOpenChange: (open: boolean) => void;
}) {
  const issueId = row?.currentIssue?.id;
  const workProductsQuery = useQuery({
    queryKey: issueId ? queryKeys.issues.workProducts(issueId) : ["work-products", "none"],
    queryFn: () => issuesApi.listWorkProducts(issueId as string),
    enabled: !!issueId,
  });

  return (
    <Sheet open={row !== null} onOpenChange={onOpenChange}>
      <SheetContent>
        {row ? (
          <>
            <SheetHeader>
              <SheetTitle>{row.agent.name}</SheetTitle>
              <SheetDescription>{row.agent.title ?? row.agent.role}</SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-3 px-4 pb-4 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">현재 상태</span>
                <OpsCategoryBadge category={row.category} />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground">현재 업무</span>
                <span>{taskSummaryFor(row.liveRun)}</span>
                {row.liveRun ? (
                  // Plain, company-prefix-unaware href on purpose — resolves via
                  // `UnprefixedBoardRedirect` in App.tsx, no Router/Company context needed here.
                  <a
                    href={`/agents/${row.agent.id}/runs/${row.liveRun.id}`}
                    className="w-fit text-xs text-primary hover:underline"
                  >
                    실행 로그 보기 →
                  </a>
                ) : null}
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground">현재 Issue</span>
                {row.currentIssue ? (
                  <a
                    href={`/issues/${row.currentIssue.identifier ?? row.currentIssue.id}`}
                    className="w-fit hover:underline"
                  >
                    {issueLabel(row.currentIssue)}
                  </a>
                ) : (
                  <span>배정된 이슈 없음</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">승인 대기</span>
                <span>{row.hasPendingApproval ? "예" : "아니오"}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">차단/오류</span>
                <span>{row.category === "blocked-error" ? "예" : "아니오"}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">마지막 하트비트</span>
                <span>{row.agent.lastHeartbeatAt ? relativeTime(row.agent.lastHeartbeatAt) : "하트비트 기록 없음"}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Work Product</span>
                <span>
                  {!issueId
                    ? "없음 (배정된 이슈 없음)"
                    : workProductsQuery.isLoading
                      ? "확인 중..."
                      : workProductsQuery.isError
                        ? "조회 실패"
                        : (workProductsQuery.data?.length ?? 0) > 0
                          ? `${workProductsQuery.data?.length}개 있음`
                          : "없음"}
                </span>
              </div>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
