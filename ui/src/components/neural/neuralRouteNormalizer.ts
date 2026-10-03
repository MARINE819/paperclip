import {
  NEURAL_ROUTE_FIXTURES,
  type CostClass,
  type FallbackCandidate,
  type LatencyClass,
  type NeuralExecutionRoute,
  type NeuralExecutionStatus,
  type NeuralRouteNormalizer,
  type VerificationStatus,
} from "./neuralCommandTypes";
import type { NeuralRouteTelemetry } from "@/api/heartbeats";

const VALID_STATUSES: Set<NeuralExecutionStatus> = new Set([
  "idle",
  "running",
  "approval_waiting",
  "failed",
  "done",
]);

const VALID_COST_CLASSES: Set<CostClass> = new Set(["low", "mid", "high"]);
const VALID_LATENCY_CLASSES: Set<LatencyClass> = new Set(["fast", "standard", "extended"]);
const VALID_VERIFICATION_STATUSES: Set<VerificationStatus> = new Set([
  "confirmed_working",
  "unverified",
  "testing",
]);

/**
 * Normalizes an arbitrary object into a typed NeuralExecutionRoute.
 * Validates essential routing attributes (Executor, Provider, Model) without
 * hardcoding role-to-model associations (e.g. coding=Codex, research=Claude).
 */
export function normalizeNeuralRoute(raw: unknown): NeuralExecutionRoute | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;

  if (typeof record.id !== "string" || !record.id.trim()) {
    return null;
  }

  const statusRaw = String(record.status ?? "idle") as NeuralExecutionStatus;
  const status: NeuralExecutionStatus = VALID_STATUSES.has(statusRaw) ? statusRaw : "idle";

  const costClassRaw = String(record.costClass ?? "low") as CostClass;
  const costClass: CostClass = VALID_COST_CLASSES.has(costClassRaw) ? costClassRaw : "low";

  const latencyClassRaw = String(record.latencyClass ?? "standard") as LatencyClass;
  const latencyClass: LatencyClass = VALID_LATENCY_CLASSES.has(latencyClassRaw)
    ? latencyClassRaw
    : "standard";

  const verificationStatusRaw = String(
    record.verificationStatus ?? "unverified",
  ) as VerificationStatus;
  const verificationStatus: VerificationStatus = VALID_VERIFICATION_STATUSES.has(
    verificationStatusRaw,
  )
    ? verificationStatusRaw
    : "unverified";

  // Normalize fallback chain if present
  let fallbackChain: FallbackCandidate[] | undefined;
  if (Array.isArray(record.fallbackChain)) {
    fallbackChain = record.fallbackChain
      .filter((item): item is Record<string, unknown> => item && typeof item === "object")
      .map((item) => ({
        executor: String(item.executor ?? "unknown"),
        provider: String(item.provider ?? "unknown"),
        model: String(item.model ?? "unknown"),
        reason: typeof item.reason === "string" ? item.reason : undefined,
      }));
  }

  // Normalize capability match array
  const capabilityMatch = Array.isArray(record.capabilityMatch)
    ? record.capabilityMatch.map((c) => String(c))
    : [];

  // Normalize approval info if present
  let approvalInfo: NeuralExecutionRoute["approvalInfo"] = null;
  if (record.approvalInfo && typeof record.approvalInfo === "object") {
    const appr = record.approvalInfo as Record<string, unknown>;
    approvalInfo = {
      id: String(appr.id ?? ""),
      title: String(appr.title ?? "승인 요청"),
      riskLevel:
        appr.riskLevel === "high" || appr.riskLevel === "medium" || appr.riskLevel === "low"
          ? appr.riskLevel
          : undefined,
    };
  }

  // Normalize incident info if present
  let incidentInfo: NeuralExecutionRoute["incidentInfo"] = null;
  if (record.incidentInfo && typeof record.incidentInfo === "object") {
    const inc = record.incidentInfo as Record<string, unknown>;
    incidentInfo = {
      code: String(inc.code ?? "UNKNOWN_INCIDENT"),
      title: String(inc.title ?? "장애 감지"),
      status: inc.status === "resolved" ? "resolved" : "open",
    };
  }

  const difficultyTier =
    record.difficultyTier === "T1" ||
    record.difficultyTier === "T2" ||
    record.difficultyTier === "T3" ||
    record.difficultyTier === "T4"
      ? record.difficultyTier
      : undefined;

  return {
    id: record.id,
    taskTitle: String(record.taskTitle ?? "작업 미지정"),
    agentId: String(record.agentId ?? ""),
    agentName: String(record.agentName ?? "Unknown Agent"),
    teamName: String(record.teamName ?? "일반"),
    status,
    executor: String(record.executor ?? "pending"),
    provider: String(record.provider ?? "pending"),
    model: String(record.model ?? "pending"),
    difficultyTier,
    selectionReason: String(record.selectionReason ?? "tier_routing"),
    capabilityMatch,
    verificationStatus,
    fallbackUsed: Boolean(record.fallbackUsed),
    fallbackAttempts:
      typeof record.fallbackAttempts === "number" ? record.fallbackAttempts : undefined,
    fallbackChain,
    failureReason: typeof record.failureReason === "string" ? record.failureReason : null,
    costClass,
    latencyClass,
    estimatedCost: typeof record.estimatedCost === "string" ? record.estimatedCost : undefined,
    actualCost: typeof record.actualCost === "string" ? record.actualCost : undefined,
    duration: typeof record.duration === "string" ? record.duration : undefined,
    routerVersion: typeof record.routerVersion === "number" ? record.routerVersion : 1,
    approvalInfo,
    incidentInfo,
    backendIntegrationPending: Boolean(record.backendIntegrationPending ?? true),
  };
}

/**
 * Fixture route normalizer implementation.
 * Ensures all normalized fixture items are safely validated and tagged
 * with backendIntegrationPending: true.
 */
export const fixtureRouteNormalizer: NeuralRouteNormalizer<NeuralExecutionRoute> = {
  normalize(raw: NeuralExecutionRoute): NeuralExecutionRoute | null {
    return normalizeNeuralRoute({
      ...raw,
      backendIntegrationPending: true,
    });
  },
  normalizeMany(rawList: NeuralExecutionRoute[]): Map<string, NeuralExecutionRoute> {
    const map = new Map<string, NeuralExecutionRoute>();
    for (const raw of rawList) {
      const normalized = this.normalize(raw);
      if (normalized) {
        map.set(normalized.agentId, normalized);
      }
    }
    return map;
  },
};

// GET /companies/:companyId/neural-routes returns heartbeat run status values
// ("queued" | "running" | "succeeded" | "failed" | "cancelled" | ...), not
// NeuralExecutionStatus. "approval_waiting" has no backend-observable source
// in this MVP (approvalInfo is explicitly deferred) and is never produced
// here. An unrecognized/future backend status fails safe to "idle" rather
// than fabricating a specific state.
const BACKEND_STATUS_TO_NEURAL_STATUS: Record<string, NeuralExecutionStatus> = {
  queued: "idle",
  running: "running",
  succeeded: "done",
  failed: "failed",
  cancelled: "failed",
};

function normalizeBackendStatus(status: unknown): NeuralExecutionStatus {
  if (typeof status !== "string") return "idle";
  return BACKEND_STATUS_TO_NEURAL_STATUS[status] ?? "idle";
}

/**
 * Backend route normalizer: maps the factual Neural telemetry DTO (GET
 * /companies/:companyId/neural-routes) onto the frontend's NeuralExecutionRoute
 * shape. Never hardcodes executor/provider/model by role, team, or agent name
 * — every routing value comes straight from the backend response. Fields the
 * backend does not yet persist (capabilityMatch, verificationStatus,
 * approvalInfo, incidentInfo, cost/latency class, fallbackChain) are left at
 * safe, non-fabricated defaults rather than invented.
 */
export function normalizeBackendNeuralRoute(raw: unknown): NeuralExecutionRoute | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.runId !== "string" || !record.runId.trim()) return null;
  if (typeof record.agentId !== "string" || !record.agentId.trim()) return null;

  const routedExecutor = typeof record.routedExecutor === "string" ? record.routedExecutor : null;
  const actualExecutor = typeof record.actualExecutor === "string" ? record.actualExecutor : null;
  const provider = typeof record.provider === "string" ? record.provider : null;
  const model = typeof record.model === "string" ? record.model : null;
  const taskId = typeof record.taskId === "string" ? record.taskId : null;
  const errorCode = typeof record.errorCode === "string" ? record.errorCode : null;
  const routingReason = typeof record.routingReason === "string" ? record.routingReason : null;

  return {
    id: record.runId,
    // Backend intentionally does not persist taskTitle (see DO NOT PERSIST
    // list) — never fabricate a plausible-looking title from taskId alone.
    taskTitle: taskId ? `작업 ID: ${taskId}` : "작업 정보 없음 (백엔드 미기록)",
    agentId: record.agentId,
    // Backend intentionally does not persist agentName/teamName; the caller
    // (useNeuralCommandData) overlays real values from its own agents/teams
    // data after normalization. Left as explicit "not yet known" here.
    agentName: "Unknown Agent",
    teamName: "일반",
    status: normalizeBackendStatus(record.status),
    // "pending" matches the same sentinel the fixture normalizer already uses
    // for a not-yet-known value — actualExecutor/provider/model are
    // genuinely null until a terminal adapterResult exists.
    executor: actualExecutor ?? routedExecutor ?? "pending",
    provider: provider ?? "pending",
    model: model ?? "pending",
    selectionReason: routingReason ?? "tier_routing",
    capabilityMatch: [],
    verificationStatus: "unverified",
    // Truthful only when BOTH values are known and actually differ — never
    // claimed from one-sided data.
    fallbackUsed: Boolean(routedExecutor && actualExecutor && actualExecutor !== routedExecutor),
    failureReason: errorCode,
    costClass: "low",
    latencyClass: "standard",
    routerVersion: 1,
    approvalInfo: null,
    incidentInfo: null,
    backendIntegrationPending: false,
  };
}

export const backendRouteNormalizer: NeuralRouteNormalizer<NeuralRouteTelemetry> = {
  normalize(raw: NeuralRouteTelemetry): NeuralExecutionRoute | null {
    return normalizeBackendNeuralRoute(raw);
  },
  normalizeMany(rawList: NeuralRouteTelemetry[]): Map<string, NeuralExecutionRoute> {
    const map = new Map<string, NeuralExecutionRoute>();
    for (const raw of rawList) {
      const normalized = this.normalize(raw);
      if (normalized) {
        map.set(normalized.agentId, normalized);
      }
    }
    return map;
  },
};

/**
 * Backend route normalizer boundary. The Intelligent Execution Router API
 * response contract has now been handed off (GET
 * /companies/:companyId/neural-routes, NeuralRouteTelemetry) — see
 * normalizeBackendNeuralRoute/backendRouteNormalizer above.
 */
export function createBackendRouteNormalizer(): NeuralRouteNormalizer<NeuralRouteTelemetry> {
  return backendRouteNormalizer;
}

/**
 * Helper to get default normalized routes from fixtures.
 */
export function getDefaultNormalizedRoutes(): Map<string, NeuralExecutionRoute> {
  const fixtureList = Object.values(NEURAL_ROUTE_FIXTURES);
  return fixtureRouteNormalizer.normalizeMany(fixtureList);
}
