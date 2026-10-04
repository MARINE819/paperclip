export type NeuralExecutionStatus = "idle" | "running" | "approval_waiting" | "failed" | "done";

export type VerificationStatus = "confirmed_working" | "unverified" | "testing";

export type CostClass = "low" | "mid" | "high";

export type LatencyClass = "fast" | "standard" | "extended";

export interface FallbackCandidate {
  executor: string;
  provider: string;
  model: string;
  reason?: string;
}

export interface NeuralExecutionRoute {
  id: string;
  taskTitle: string;
  agentId: string;
  agentName: string;
  teamName: string;
  status: NeuralExecutionStatus;
  executor: string;
  provider: string;
  model: string;
  difficultyTier?: "T1" | "T2" | "T3" | "T4";
  selectionReason: string;
  capabilityMatch: string[];
  verificationStatus: VerificationStatus;
  fallbackUsed: boolean;
  fallbackAttempts?: number;
  fallbackChain?: FallbackCandidate[];
  failureReason?: string | null;
  costClass: CostClass;
  latencyClass: LatencyClass;
  estimatedCost?: string;
  actualCost?: string;
  duration?: string;
  routerVersion: number;
  approvalInfo?: {
    id: string;
    title: string;
    riskLevel?: "low" | "medium" | "high";
  } | null;
  incidentInfo?: {
    code: string;
    title: string;
    status: "open" | "resolved";
  } | null;
  backendIntegrationPending: boolean;
}

export interface NeuralTeam {
  id: string;
  name: string;
  iconName?: string;
  agentIds: string[];
  activeTaskCount: number;
  hasApprovalWaiting: boolean;
  hasFailure: boolean;
}

/**
 * Typed frontend mock fixtures.
 * CRITICAL RULE: No hardcoding of specific AI roles (e.g., coding=Codex, research=Claude).
 * These fixtures display generic data received from router simulations.
 * All fixtures are explicitly marked with backendIntegrationPending: true.
 */
export const NEURAL_ROUTE_FIXTURES: Record<string, NeuralExecutionRoute> = {
  // Case 1: Primary running execution with multi-capability match
  "exec-run-1": {
    id: "exec-run-1",
    taskTitle: "핵심 시장 경쟁사 분석 및 기능 벤치마킹",
    agentId: "agent-pm-1",
    agentName: "윤지우",
    teamName: "기획·전략팀",
    status: "running",
    executor: "claude_local",
    provider: "anthropic",
    model: "claude-3-5-sonnet",
    difficultyTier: "T3",
    selectionReason: "tier_routing",
    capabilityMatch: ["deep_reasoning", "document_synthesis", "strategic_planning"],
    verificationStatus: "confirmed_working",
    fallbackUsed: false,
    costClass: "mid",
    latencyClass: "standard",
    estimatedCost: "$0.08",
    actualCost: "$0.05",
    duration: "14.2s (진행 중)",
    routerVersion: 1,
    approvalInfo: null,
    incidentInfo: null,
    backendIntegrationPending: true,
  },
  // Case 2: Approval waiting gate (high risk action)
  "exec-approval-2": {
    id: "exec-approval-2",
    taskTitle: "프로덕션 데이터 수명 주기 정책 아카이브 실행",
    agentId: "agent-audit-1",
    agentName: "임도현",
    teamName: "재무·관리팀",
    status: "approval_waiting",
    executor: "codex_local",
    provider: "openai",
    model: "gpt-4o",
    difficultyTier: "T2",
    selectionReason: "agent_explicit_override",
    capabilityMatch: ["system_audit", "policy_validation"],
    verificationStatus: "confirmed_working",
    fallbackUsed: false,
    costClass: "low",
    latencyClass: "fast",
    estimatedCost: "$0.02",
    actualCost: "$0.01",
    duration: "대기 중",
    routerVersion: 1,
    approvalInfo: {
      id: "appr-gate-901",
      title: "보존 기간 만료 데이터 영구 보관소 이동 승인 요청",
      riskLevel: "high",
    },
    incidentInfo: null,
    backendIntegrationPending: true,
  },
  // Case 3: Fallback used after primary failure
  "exec-fallback-3": {
    id: "exec-fallback-3",
    taskTitle: "비정형 지식 베이스 벡터 인덱싱 및 임베딩 갱신",
    agentId: "agent-knowledge-1",
    agentName: "백지수",
    teamName: "개발팀",
    status: "running",
    executor: "gemini_local",
    provider: "google",
    model: "gemini-1.5-pro",
    difficultyTier: "T2",
    selectionReason: "fallback_routing",
    capabilityMatch: ["large_context", "vector_indexing"],
    verificationStatus: "confirmed_working",
    fallbackUsed: true,
    fallbackAttempts: 1,
    fallbackChain: [
      {
        executor: "codex_local",
        provider: "openai",
        model: "gpt-4o-mini",
        reason: "rate_limited",
      },
    ],
    failureReason: null,
    costClass: "low",
    latencyClass: "fast",
    estimatedCost: "$0.03",
    actualCost: "$0.02",
    duration: "8.7s",
    routerVersion: 1,
    approvalInfo: null,
    incidentInfo: null,
    backendIntegrationPending: true,
  },
  // Case 4: Failed execution with incident correlation
  "exec-failed-4": {
    id: "exec-failed-4",
    taskTitle: "원격 빌드 파이프라인 통합 무결성 테스트",
    agentId: "agent-qa-1",
    agentName: "정하은",
    teamName: "QA·품질팀",
    status: "failed",
    executor: "codex_local",
    provider: "openai",
    model: "o1-mini",
    difficultyTier: "T4",
    selectionReason: "tier_routing",
    capabilityMatch: ["test_generation", "code_analysis"],
    verificationStatus: "unverified",
    fallbackUsed: false,
    failureReason: "windows_control_c_exit_detected",
    costClass: "high",
    latencyClass: "extended",
    estimatedCost: "$0.12",
    actualCost: "$0.04",
    duration: "45.0s (중단)",
    routerVersion: 1,
    approvalInfo: null,
    incidentInfo: {
      code: "windows_control_c_exit_detected",
      title: "Windows 호스트 프로세스 제어 신호 수신 중단",
      status: "resolved",
    },
    backendIntegrationPending: true,
  },
  // Case 5: Done execution
  "exec-done-5": {
    id: "exec-done-5",
    taskTitle: "주간 AI 운영 지표 요약 및 경영진 보고서 생성",
    agentId: "agent-jarvis-core",
    agentName: "JARVIS",
    teamName: "경영진 / 비서실",
    status: "done",
    executor: "claude_local",
    provider: "anthropic",
    model: "claude-3-5-sonnet",
    difficultyTier: "T3",
    selectionReason: "tier_routing",
    capabilityMatch: ["orchestration", "synthesis", "reporting"],
    verificationStatus: "confirmed_working",
    fallbackUsed: false,
    costClass: "mid",
    latencyClass: "standard",
    estimatedCost: "$0.06",
    actualCost: "$0.05",
    duration: "21.3s",
    routerVersion: 1,
    approvalInfo: null,
    incidentInfo: null,
    backendIntegrationPending: true,
  },
};

export const NEURAL_STATUS_LABELS: Record<NeuralExecutionStatus, string> = {
  idle: "대기",
  running: "실행 중",
  approval_waiting: "승인 대기",
  failed: "실패",
  done: "완료",
};

export const NEURAL_STATUS_VARS: Record<NeuralExecutionStatus, string> = {
  idle: "--status-agent-idle",
  running: "--status-agent-running",
  approval_waiting: "--status-agent-paused",
  failed: "--status-agent-error",
  done: "--status-agent-running",
};

/**
 * Explicit data source lifecycle state:
 * - loading: query in flight or bootstrapping
 * - ready: live verified telemetry confirmed
 * - empty: zero agents/teams in organization
 * - error: upstream query failure or corrupt route payload
 * - backend_pending: simulated fixture route active pending backend API handoff
 */
export type NeuralDataState = "loading" | "ready" | "empty" | "error" | "backend_pending";

/**
 * Data provenance indicator:
 * - fixture: pure client-side simulation fixture
 * - live: real backend router telemetry (future)
 * - mixed: live agent/org roster + simulated fixture routes
 */
export type NeuralDataSource = "fixture" | "live" | "mixed";

export interface NeuralAgentSummary {
  id: string;
  name: string;
  title?: string | null;
  role: string;
  orgUnitId?: string | null;
  status: string;
  lastHeartbeatAt?: string | Date | null;
}

/**
 * 8-State lifecycle for JARVIS Central Core.
 *
 * NOTE on Backend Contract Truthfulness:
 * - UI-ONLY STATES:
 *   - "listening": Derived exclusively from active voice input (VoiceCommandBar state === "listening"). Not a backend status.
 *   - "planning": Derived exclusively from client voice processing (VoiceCommandBar state === "processing") or local context. Not a backend status.
 *   - "dispatching": Derived from heartbeat_runs.status === "queued" (waiting for agent process wake/pickup). UI-only label for queued runs; not a native backend "dispatching" enum.
 *
 * - BACKEND-LINKED STATES:
 *   - "working": Derived from active heartbeat_runs (status === "running").
 *   - "approval": Derived from real pending approvals (approvalsApi / pendingApprovals).
 *   - "error": Derived from real failed/timed_out terminal runs or agent error condition. Preserves original error code.
 *   - "done": Derived from real terminal succeeded runs (heartbeat_runs.status === "succeeded").
 *   - "idle": When no active runs, pending approvals, or voice activities exist.
 */
export type JarvisCoreState =
  | "idle"
  | "listening"
  | "planning"
  | "dispatching"
  | "working"
  | "approval"
  | "error"
  | "done";

export const JARVIS_CORE_STATE_LABELS: Record<JarvisCoreState, string> = {
  idle: "명령 대기",
  listening: "음성 청취 중 (UI 전용)",
  planning: "명령 계획/분해 (UI 전용)",
  dispatching: "에이전트 배치 중 (대기열 기반 UI 전용)",
  working: "작업 수행 중",
  approval: "결재 승인 대기",
  error: "이상 감지",
  done: "정상 완료",
};

/**
 * CEO Briefing Summary:
 * Strict rule: Factual, backend-verified business task aggregates aligned with dashboard semantics.
 * - completedCount: Factual count of business issues with status === "done" (NOT run-level succeeded count).
 * - blockedCount: Factual count of business issues with status === "blocked" (NOT agent errors or approvals).
 * - pendingApprovalCount: Factual count of active pending approvals from approvals API (excluding expired/consumed).
 * Note: failedCount is deliberately omitted because the backend has no task-level FAILED aggregate contract yet.
 */
export interface CeoBriefingSummary {
  completedCount: number | null;
  blockedCount: number | null;
  pendingApprovalCount: number | null;
  recentActivity?: string | null;
}

/**
 * JarvisReturnLoopData:
 * Strictly populated from TERMINAL runs only (finishedAt !== null, status in "succeeded" | "failed" | "timed_out").
 * NEVER used for active/queued runs to guess or speculate routedExecutor/provider/model.
 */
export interface JarvisReturnLoopData {
  runId: string;
  status: "succeeded" | "failed" | "timed_out";
  finishedAt: string;
  agentId: string;
  agentName: string;
  taskTitle: string;
  routedExecutor: string | null;
  actualExecutor: string | null;
  provider: string | null;
  model: string | null;
  errorCode: string | null;
  executionDurationMs?: number | null;
  obsidianPath?: string | null;
  obsidianSyncState?: "synced" | "pending" | "failed" | "skipped" | null;
  obsidianSyncedAt?: string | null;
}

export interface NeuralViewModel {
  state: NeuralDataState;
  source: NeuralDataSource;
  backendIntegrationPending: boolean;
  teams: NeuralTeam[];
  agents: NeuralAgentSummary[];
  routesByAgentId: Map<string, NeuralExecutionRoute>;
  activeRoute: NeuralExecutionRoute | null;
  sourceLabel: string;
  error?: string | null;
  jarvisState: JarvisCoreState;
  ceoBriefing: CeoBriefingSummary;
  recentReturnLoop: JarvisReturnLoopData | null;
}

export interface NeuralRouteNormalizer<TRaw = unknown> {
  normalize(raw: TRaw): NeuralExecutionRoute | null;
  normalizeMany(rawList: TRaw[]): Map<string, NeuralExecutionRoute>;
}

