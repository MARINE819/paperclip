import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { heartbeatsApi } from "@/api/heartbeats";
import {
  type CeoBriefingSummary,
  type JarvisCoreState,
  type JarvisReturnLoopData,
  type NeuralAgentSummary,
  type NeuralDataSource,
  type NeuralDataState,
  type NeuralExecutionRoute,
  type NeuralRouteNormalizer,
  type NeuralTeam,
  type NeuralViewModel,
} from "./neuralCommandTypes";
import {
  createBackendRouteNormalizer,
  fixtureRouteNormalizer,
  getDefaultNormalizedRoutes,
} from "./neuralRouteNormalizer";

export interface UseNeuralCommandDataOptions {
  agents?: Array<{
    id: string;
    name: string;
    title?: string | null;
    role: string;
    orgUnitId?: string | null;
    status: string;
    lastHeartbeatAt?: string | Date | null;
  }>;
  orgUnits?: Array<{
    orgUnitId: string;
    name: string;
  }>;
  liveRuns?: Array<{
    agentId: string;
    triggerDetail?: string | null;
    currentStatusMessage?: string | null;
  }>;
  pendingApprovals?: Array<{
    id: string;
    type: string;
    status?: string;
    effectiveStatus?: string;
    requestedByAgentId?: string | null;
  }>;
  /**
   * Pre-aggregated task counts from the dashboard API (tasks.done, tasks.blocked).
   * Passed from parent to avoid duplicate network queries. null indicates loading/unknown.
   */
  completedCount?: number | null;
  blockedCount?: number | null;
  pendingApprovalCount?: number | null;
  /**
   * Optional pre-fetched knowledge records for Obsidian linkage.
   */
  knowledgeRecords?: Array<{
    id: string;
    title: string;
    obsidianPath: string | null;
    obsidianSyncState: "synced" | "pending" | "failed" | "skipped";
    obsidianSyncedAt: string | null;
    sourceRunId: string | null;
    sourceAgentId: string | null;
  }>;
  /**
   * UI-only voice state ("listening" | "processing" | "idle") from VoiceCommandBar.
   */
  voiceState?: string;
  isLoading?: boolean;
  error?: Error | string | null;
  selectedTeamId?: string | null;
  selectedAgentId?: string | null;
  sourceOverride?: NeuralDataSource;
  fixtureRoutesOverride?: Record<string, NeuralExecutionRoute>;
  routeNormalizer?: NeuralRouteNormalizer<NeuralExecutionRoute>;
  /**
   * Company id to fetch real Neural routing telemetry for (Phase 2B MVP,
   * GET /companies/:companyId/neural-routes). Omit (or pass null/undefined)
   * to keep the exact Phase 2A fixture-only behavior — this hook never
   * fetches anything unless a companyId is explicitly supplied.
   */
  companyId?: string | null;
}

export function useNeuralCommandData(
  options: UseNeuralCommandDataOptions = {},
): NeuralViewModel {
  const {
    agents = [],
    orgUnits = [],
    liveRuns = [],
    pendingApprovals = [],
    isLoading = false,
    error = null,
    selectedAgentId = null,
    sourceOverride,
    fixtureRoutesOverride,
    routeNormalizer = fixtureRouteNormalizer,
    companyId = null,
  } = options;

  // Phase 2B MVP: this hook performs its own GET for real routing telemetry
  // when given a companyId — callers that never pass one (existing Phase 2A
  // usage) get `enabled: false`, so nothing fetches and behavior is unchanged.
  const neuralRoutesQuery = useQuery({
    queryKey: ["neural-routes", companyId],
    queryFn: () => heartbeatsApi.neuralRoutes(companyId as string),
    enabled: Boolean(companyId),
    refetchInterval: 15_000,
  });

  // LIVE requires an actual successful backend telemetry response — never
  // just a prop/override saying so. An empty array is still a genuine
  // response (truthfully: no run telemetry exists yet) and counts as real.
  const backendTelemetryConfirmed = Boolean(companyId) && neuralRoutesQuery.isSuccess;

  // 1. Determine active data source provenance
  const source: NeuralDataSource = useMemo(() => {
    if (backendTelemetryConfirmed) return "live";
    // sourceOverride="live" alone is never sufficient without a confirmed
    // backend response — downgrade a false live claim to "fixture" rather
    // than trust it (same visible outcome Phase 2A already had, since its
    // label function ignored a raw "live" source value entirely).
    if (sourceOverride === "live") return "fixture";
    if (sourceOverride) return sourceOverride;
    if (agents.length > 0) return "mixed"; // Live agents + simulation route fixtures
    return "fixture";
  }, [backendTelemetryConfirmed, sourceOverride, agents.length]);

  // Architectural Invariant (Phase 2A): LIVE_MODE_IMPLEMENTED = NO by default.
  // Fixture data must NEVER pretend to be live. backendIntegrationPending only
  // flips to false once backendTelemetryConfirmed is genuinely true.
  const backendIntegrationPending = !backendTelemetryConfirmed;

  // 2. Normalization of routes. Backend-normalized routes do not carry
  // agentName/teamName (the backend intentionally never persists those —
  // see neuralRouteNormalizer.ts) and the backend normalizer leaves safe
  // placeholders in their place; the overlay below replaces those
  // placeholders with the real names already available from `agents`/`teams`
  // instead of ever trusting the backend to fabricate them.
  const baseRoutesByAgentId = useMemo<Map<string, NeuralExecutionRoute>>(() => {
    if (backendTelemetryConfirmed) {
      return createBackendRouteNormalizer().normalizeMany(neuralRoutesQuery.data ?? []);
    }
    if (fixtureRoutesOverride) {
      return routeNormalizer.normalizeMany(Object.values(fixtureRoutesOverride));
    }
    return getDefaultNormalizedRoutes();
  }, [backendTelemetryConfirmed, neuralRoutesQuery.data, fixtureRoutesOverride, routeNormalizer]);

  // 3. Teams construction from live frontend data or default structure
  const teams: NeuralTeam[] = useMemo(() => {
    // Case A: If both agents and orgUnits are empty, return empty teams array
    if (agents.length === 0 && orgUnits.length === 0) {
      return [];
    }

    const liveRunAgentIds = new Set(liveRuns.map((r) => r.agentId));
    const pendingApprovalAgentIds = new Set(
      pendingApprovals
        .filter((a) => a.effectiveStatus === "pending")
        .map((a) => a.requestedByAgentId)
        .filter((id): id is string => Boolean(id)),
    );

    // Case B: If orgUnits exist, map each orgUnit to a NeuralTeam
    if (orgUnits.length > 0) {
      const list: NeuralTeam[] = orgUnits.map((ou) => {
        const teamAgents = agents.filter((a) => a.orgUnitId === ou.orgUnitId);
        const agentIds = teamAgents.map((a) => a.id);
        const activeTaskCount = agentIds.filter((id) => liveRunAgentIds.has(id)).length;
        const hasApprovalWaiting = agentIds.some((id) => pendingApprovalAgentIds.has(id));
        const hasFailure = agentIds.some((id) => {
          const r = baseRoutesByAgentId.get(id);
          return r?.status === "failed";
        });

        return {
          id: ou.orgUnitId,
          name: ou.name,
          agentIds,
          activeTaskCount,
          hasApprovalWaiting,
          hasFailure,
        };
      });

      // Include unassigned agents into an executive or general team if needed
      const assignedIds = new Set(list.flatMap((t) => t.agentIds));
      const unassigned = agents.filter((a) => !assignedIds.has(a.id));
      if (unassigned.length > 0) {
        list.unshift({
          id: "team-general",
          name: "경영진 / 직속",
          agentIds: unassigned.map((a) => a.id),
          activeTaskCount: unassigned.filter((a) => liveRunAgentIds.has(a.id)).length,
          hasApprovalWaiting: unassigned.some((a) => pendingApprovalAgentIds.has(a.id)),
          hasFailure: unassigned.some((a) => baseRoutesByAgentId.get(a.id)?.status === "failed"),
        });
      }

      return list;
    }

    // Case C: Fallback structure when agents exist without explicit orgUnits
    return [
      {
        id: "team-exec",
        name: "경영진 / 비서실",
        agentIds: agents.filter((a) => a.role === "ceo" || a.name.includes("JARVIS")).map((a) => a.id),
        activeTaskCount: 1,
        hasApprovalWaiting: false,
        hasFailure: false,
      },
      {
        id: "team-planning",
        name: "기획·전략팀",
        agentIds: agents.filter((a) => a.id === "agent-pm-1" || a.role.includes("기획")).map((a) => a.id),
        activeTaskCount: 1,
        hasApprovalWaiting: false,
        hasFailure: false,
      },
      {
        id: "team-dev",
        name: "개발팀",
        agentIds: agents.filter((a) => a.id === "agent-dev-1" || a.role.includes("개발") || a.role.includes("지식")).map((a) => a.id),
        activeTaskCount: 1,
        hasApprovalWaiting: false,
        hasFailure: false,
      },
      {
        id: "team-finance",
        name: "재무·관리팀",
        agentIds: agents.filter((a) => a.id === "agent-audit-1" || a.role.includes("재무") || a.role.includes("감시")).map((a) => a.id),
        activeTaskCount: 0,
        hasApprovalWaiting: true,
        hasFailure: false,
      },
      {
        id: "team-qa",
        name: "QA·품질팀",
        agentIds: agents.filter((a) => a.id === "agent-qa-1" || a.role.includes("QA") || a.role.includes("품질")).map((a) => a.id),
        activeTaskCount: 0,
        hasApprovalWaiting: false,
        hasFailure: true,
      },
    ];
  }, [agents, orgUnits, liveRuns, pendingApprovals, baseRoutesByAgentId]);

  // 4. Normalized agent list
  const normalizedAgents: NeuralAgentSummary[] = useMemo(() => {
    return agents.map((a) => ({
      id: a.id,
      name: a.name,
      title: a.title,
      role: a.role,
      orgUnitId: a.orgUnitId,
      status: a.status,
      lastHeartbeatAt: a.lastHeartbeatAt,
    }));
  }, [agents]);

  // 4b. Overlay real agentName/teamName onto backend-sourced routes. The
  // backend normalizer leaves "Unknown Agent" / "일반" placeholders (it has
  // no access to org data) — replaced here with the real values already
  // available from `agents`/`teams`, never fabricated by either side.
  const routesByAgentId = useMemo<Map<string, NeuralExecutionRoute>>(() => {
    if (!backendTelemetryConfirmed) return baseRoutesByAgentId;
    const agentNameById = new Map(agents.map((a) => [a.id, a.name]));
    const teamNameByAgentId = new Map(
      teams.flatMap((team) => team.agentIds.map((id) => [id, team.name] as const)),
    );
    const enriched = new Map<string, NeuralExecutionRoute>();
    for (const [agentId, route] of baseRoutesByAgentId) {
      enriched.set(agentId, {
        ...route,
        agentName: agentNameById.get(agentId) ?? route.agentName,
        teamName: teamNameByAgentId.get(agentId) ?? route.teamName,
      });
    }
    return enriched;
  }, [backendTelemetryConfirmed, baseRoutesByAgentId, agents, teams]);

  // 5. Active route computation
  const activeRoute = useMemo<NeuralExecutionRoute | null>(() => {
    if (selectedAgentId && routesByAgentId.has(selectedAgentId)) {
      return routesByAgentId.get(selectedAgentId)!;
    }
    // Default to the first available route in the map
    return routesByAgentId.values().next().value ?? null;
  }, [selectedAgentId, routesByAgentId]);

  // 6. Explicit Lifecycle State
  const errorMessage = error instanceof Error ? error.message : typeof error === "string" ? error : null;
  const isError = Boolean(errorMessage);
  const isEmpty = !isLoading && !isError && agents.length === 0 && orgUnits.length === 0;

  const state: NeuralDataState = useMemo(() => {
    if (isLoading) return "loading";
    if (isError) return "error";
    if (isEmpty) return "empty";
    // "ready" only once real backend telemetry is confirmed (Phase 2B MVP).
    // Fixture/mixed states remain "backend_pending", same as Phase 2A.
    if (backendTelemetryConfirmed) return "ready";
    return "backend_pending";
  }, [isLoading, isError, isEmpty, backendTelemetryConfirmed]);

  // 7. Human-readable provenance label
  const sourceLabel = useMemo(() => {
    if (source === "live") {
      return "실시간 백엔드 라우팅 텔레메트리 (연동 완료)";
    }
    if (source === "mixed") {
      return "혼합 모드 (라이브 조직 + 시뮬레이션 라우트)";
    }
    // Fixture data must NEVER pretend to be live.
    return "시뮬레이션 픽스처 (백엔드 연동 대기)";
  }, [source]);

  // 8. CEO Briefing: derived strictly from pre-aggregated dashboard values passed from parent
  const ceoBriefing: CeoBriefingSummary = useMemo(() => {
    // Preserve null when loading or unknown — never convert to 0
    const completedCount =
      options.completedCount !== undefined ? options.completedCount : null;
    const blockedCount =
      options.blockedCount !== undefined ? options.blockedCount : null;
    const pendingApprovalCount =
      options.pendingApprovalCount !== undefined
        ? options.pendingApprovalCount
        : null;

    const latestRunning = liveRuns.find((r) => r.triggerDetail || r.currentStatusMessage);
    const recentActivity = latestRunning
      ? (latestRunning.triggerDetail ?? latestRunning.currentStatusMessage ?? null)
      : null;

    return {
      completedCount,
      blockedCount,
      pendingApprovalCount,
      recentActivity,
    };
  }, [options.completedCount, options.blockedCount, options.pendingApprovalCount, liveRuns]);

  // 9. Return Loop: strictly terminal runs only (never speculative active runs)
  const recentReturnLoop: JarvisReturnLoopData | null = useMemo(() => {
    const liveTelemetry = neuralRoutesQuery.data ?? [];
    const terminalTelemetry = liveTelemetry.filter(
      (r) =>
        r.finishedAt &&
        (r.status === "succeeded" || r.status === "failed" || r.status === "timed_out"),
    );

    if (terminalTelemetry.length > 0) {
      const latest = [...terminalTelemetry].sort(
        (a, b) => new Date(b.finishedAt!).getTime() - new Date(a.finishedAt!).getTime(),
      )[0]!;

      const agent = agents.find((a) => a.id === latest.agentId);
      // Strictly match sourceRunId === latest.runId. Never link past runs of the same agent.
      const matchingKnowledge = (options.knowledgeRecords ?? []).find(
        (k) => k.sourceRunId && k.sourceRunId === latest.runId,
      );

      // Preserve actual terminal status: succeeded | failed | timed_out
      const terminalStatus =
        latest.status === "succeeded"
          ? ("succeeded" as const)
          : latest.status === "timed_out"
            ? ("timed_out" as const)
            : ("failed" as const);

      return {
        runId: latest.runId,
        status: terminalStatus,
        finishedAt: latest.finishedAt!,
        agentId: latest.agentId,
        agentName: agent?.name ?? "에이전트",
        taskTitle: latest.taskId
          ? `작업 ID: ${latest.taskId} (ID 기준 표기)`
          : "작업 정보 미기록 (백엔드 미기록)",
        routedExecutor: latest.routedExecutor ?? null,
        actualExecutor: latest.actualExecutor ?? null,
        provider: latest.provider ?? null,
        model: latest.model ?? null,
        errorCode: latest.errorCode ?? null,
        obsidianPath: matchingKnowledge?.obsidianPath ?? null,
        obsidianSyncState: matchingKnowledge?.obsidianSyncState ?? null,
        obsidianSyncedAt: matchingKnowledge?.obsidianSyncedAt ?? null,
      };
    }

    if (!backendTelemetryConfirmed) {
      const fixtureDone = [...routesByAgentId.values()].find((r) => r.status === "done");
      if (fixtureDone) {
        return {
          runId: fixtureDone.id,
          status: "succeeded",
          finishedAt: new Date().toISOString(),
          agentId: fixtureDone.agentId,
          agentName: fixtureDone.agentName,
          taskTitle: fixtureDone.taskTitle,
          routedExecutor: fixtureDone.executor,
          actualExecutor: fixtureDone.executor,
          provider: fixtureDone.provider,
          model: fixtureDone.model,
          errorCode: null,
          obsidianPath: null,
          obsidianSyncState: null,
          obsidianSyncedAt: null,
        };
      }
    }

    return null;
  }, [
    neuralRoutesQuery.data,
    backendTelemetryConfirmed,
    routesByAgentId,
    agents,
    options.knowledgeRecords,
  ]);

  // 10. Truthful 8-State derivation (listening/planning/dispatching are UI-only)
  const jarvisState: JarvisCoreState = useMemo(() => {
    // 1. UI-only: Voice listening
    if (options.voiceState === "listening") return "listening";
    // UI-only: Voice processing / planning
    if (options.voiceState === "processing") return "planning";

    // 2. Pending Approval: strictly effectiveStatus === "pending"
    const hasActivePendingApprovals = pendingApprovals.some(
      (a) => a.effectiveStatus === "pending",
    );
    if (hasActivePendingApprovals) return "approval";

    // 3. Error
    const hasFailedRoute = [...routesByAgentId.values()].some(
      (r) => r.status === "failed",
    );
    if (hasFailedRoute) return "error";

    // 4. Dispatching (UI-only for queued runs waiting in scheduler queue)
    const hasQueuedRun = (neuralRoutesQuery.data ?? []).some((r) => r.status === "queued");
    if (hasQueuedRun) return "dispatching";

    // 5. Working
    const hasRunningRun =
      liveRuns.length > 0 || [...routesByAgentId.values()].some((r) => r.status === "running");
    if (hasRunningRun) return "working";

    // 6. Done (recent terminal succeeded run within last 60 seconds)
    if (recentReturnLoop?.status === "succeeded") {
      const diffMs = Date.now() - new Date(recentReturnLoop.finishedAt).getTime();
      if (diffMs < 60_000) {
        return "done";
      }
    }

    // 7. Idle
    return "idle";
  }, [
    options.voiceState,
    pendingApprovals,
    routesByAgentId,
    neuralRoutesQuery.data,
    liveRuns,
    recentReturnLoop,
  ]);

  return {
    state,
    source,
    backendIntegrationPending,
    teams,
    agents: normalizedAgents,
    routesByAgentId,
    activeRoute,
    sourceLabel,
    error: errorMessage,
    jarvisState,
    ceoBriefing,
    recentReturnLoop,
  };
}

