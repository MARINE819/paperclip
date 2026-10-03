// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const mockHeartbeatsApi = vi.hoisted(() => ({
  neuralRoutes: vi.fn(),
}));

vi.mock("@/api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

import {
  useNeuralCommandData,
  type UseNeuralCommandDataOptions,
} from "./useNeuralCommandData";
import {
  createBackendRouteNormalizer,
  fixtureRouteNormalizer,
  normalizeNeuralRoute,
} from "./neuralRouteNormalizer";
import {
  NEURAL_ROUTE_FIXTURES,
  type NeuralViewModel,
} from "./neuralCommandTypes";
import type { NeuralRouteTelemetry } from "@/api/heartbeats";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Pure React hook test harness without JSX syntax for .ts compatibility
 */
function renderNeuralHook(options: UseNeuralCommandDataOptions): NeuralViewModel {
  let output!: NeuralViewModel;
  function TestHookComponent() {
    output = useNeuralCommandData(options);
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  // Phase 2B MVP: the hook now calls useQuery internally (disabled unless a
  // companyId is passed), which requires a QueryClientProvider ancestor even
  // when the query never actually fires.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(TestHookComponent),
      ),
    );
  });
  act(() => {
    root.unmount();
  });
  return output;
}

/**
 * Same harness as renderNeuralHook, but keeps the component mounted and
 * flushes pending microtasks so the hook's internal useQuery (backend GET)
 * actually resolves before returning the final view model.
 */
async function renderNeuralHookAsync(options: UseNeuralCommandDataOptions): Promise<NeuralViewModel> {
  let output!: NeuralViewModel;
  function TestHookComponent() {
    output = useNeuralCommandData(options);
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(TestHookComponent),
      ),
    );
  });
  // Flush the queryFn promise and the resulting re-render(s) in their own
  // act() calls, separate from the initial render's act(), so React commits
  // each intermediate state change along the way.
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  await act(async () => {
    root.unmount();
  });
  return output;
}

describe("Phase 2A — Data Source Boundary & Normalization Layer", () => {
  const MOCK_AGENTS = [
    {
      id: "agent-pm-1",
      name: "윤지우",
      title: "PM",
      role: "기획·전략팀장",
      orgUnitId: "team-planning",
      status: "running",
    },
    {
      id: "agent-dev-1",
      name: "백지수",
      title: "Knowledge",
      role: "지식관리",
      orgUnitId: "team-dev",
      status: "running",
    },
  ];

  const MOCK_ORG_UNITS = [
    { orgUnitId: "team-planning", name: "기획·전략팀" },
    { orgUnitId: "team-dev", name: "개발팀" },
  ];

  describe("normalizeNeuralRoute", () => {
    it("returns null for non-objects or missing id", () => {
      expect(normalizeNeuralRoute(null)).toBeNull();
      expect(normalizeNeuralRoute(undefined)).toBeNull();
      expect(normalizeNeuralRoute("string")).toBeNull();
      expect(normalizeNeuralRoute({})).toBeNull();
      expect(normalizeNeuralRoute({ id: "" })).toBeNull();
    });

    it("normalizes route faithfully without hardcoded stereotypes", () => {
      const raw = {
        id: "raw-route-1",
        taskTitle: "분산 GPU 노드 스케줄링",
        agentId: "agent-custom",
        agentName: "노드관리자",
        teamName: "인프라팀",
        status: "running",
        executor: "k8s_job_runner",
        provider: "local_cluster",
        model: "deepseek-coder",
        difficultyTier: "T3",
        selectionReason: "custom_scheduler",
        capabilityMatch: ["gpu_dispatch", "batch_processing"],
        costClass: "mid",
        latencyClass: "fast",
        backendIntegrationPending: true,
      };

      const route = normalizeNeuralRoute(raw);
      expect(route).not.toBeNull();
      expect(route?.executor).toBe("k8s_job_runner");
      expect(route?.provider).toBe("local_cluster");
      expect(route?.model).toBe("deepseek-coder");
      expect(route?.selectionReason).toBe("custom_scheduler");
      expect(route?.capabilityMatch).toEqual(["gpu_dispatch", "batch_processing"]);
    });

    it("fixtureRouteNormalizer always forces backendIntegrationPending to true", () => {
      const fixture = NEURAL_ROUTE_FIXTURES["exec-run-1"]!;
      const normalized = fixtureRouteNormalizer.normalize({
        ...fixture,
        backendIntegrationPending: false, // attempt to bypass
      });
      expect(normalized?.backendIntegrationPending).toBe(true);
    });

    it("createBackendRouteNormalizer maps a valid backend DTO truthfully, preferring actualExecutor over routedExecutor", () => {
      const normalizer = createBackendRouteNormalizer();
      const dto: NeuralRouteTelemetry = {
        runId: "run-1",
        companyId: "company-1",
        agentId: "agent-pm-1",
        routedExecutor: "codex_local",
        actualExecutor: "claude_local",
        routingReason: "tier_routing",
        status: "succeeded",
        startedAt: "2026-10-01T00:00:00.000Z",
        source: "live",
        taskId: "task-9",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        errorCode: null,
      };

      const route = normalizer.normalize(dto);
      expect(route).not.toBeNull();
      expect(route?.id).toBe("run-1");
      expect(route?.agentId).toBe("agent-pm-1");
      expect(route?.status).toBe("done");
      expect(route?.executor).toBe("claude_local");
      expect(route?.provider).toBe("anthropic");
      expect(route?.model).toBe("claude-3-5-sonnet");
      expect(route?.fallbackUsed).toBe(true);
      // Truthful source provenance: this route genuinely came from the
      // backend, so it must never be marked backendIntegrationPending.
      expect(route?.backendIntegrationPending).toBe(false);
    });

    it("createBackendRouteNormalizer leaves actualExecutor/provider/model as pending for an active run with no terminal adapterResult yet", () => {
      const normalizer = createBackendRouteNormalizer();
      const dto: NeuralRouteTelemetry = {
        runId: "run-2",
        companyId: "company-1",
        agentId: "agent-pm-1",
        routedExecutor: "codex_local",
        actualExecutor: null,
        routingReason: "tier_routing",
        status: "running",
        startedAt: "2026-10-01T00:00:00.000Z",
        source: "live",
        provider: null,
        model: null,
      };

      const route = normalizer.normalize(dto);
      expect(route).not.toBeNull();
      expect(route?.status).toBe("running");
      // Never fabricate actualExecutor — falls back to the known routed value.
      expect(route?.executor).toBe("codex_local");
      expect(route?.provider).toBe("pending");
      expect(route?.model).toBe("pending");
      // fallbackUsed can't be claimed when actualExecutor is still unknown.
      expect(route?.fallbackUsed).toBe(false);
    });

    it("createBackendRouteNormalizer surfaces a failed run's errorCode truthfully", () => {
      const normalizer = createBackendRouteNormalizer();
      const route = normalizer.normalize({
        runId: "run-3",
        companyId: "company-1",
        agentId: "agent-qa-1",
        routedExecutor: "codex_local",
        actualExecutor: "codex_local",
        routingReason: "tier_routing",
        status: "failed",
        startedAt: "2026-10-01T00:00:00.000Z",
        source: "live",
        errorCode: "windows_control_c_exit_detected",
      });

      expect(route?.status).toBe("failed");
      expect(route?.failureReason).toBe("windows_control_c_exit_detected");
      expect(route?.fallbackUsed).toBe(false);
    });

    it("createBackendRouteNormalizer fails safe (null) on an invalid/malformed DTO", () => {
      const normalizer = createBackendRouteNormalizer();
      expect(normalizer.normalize({ anyField: "value" } as unknown as NeuralRouteTelemetry)).toBeNull();
      expect(normalizer.normalizeMany([{ id: "1" } as unknown as NeuralRouteTelemetry]).size).toBe(0);
      expect(normalizer.normalize(null as unknown as NeuralRouteTelemetry)).toBeNull();
    });
  });

  describe("useNeuralCommandData Hook", () => {
    it("A. returns backend_pending state with fixture data by default", () => {
      const result = renderNeuralHook({
        agents: MOCK_AGENTS,
        orgUnits: MOCK_ORG_UNITS,
      });

      expect(result.state).toBe("backend_pending");
      expect(result.backendIntegrationPending).toBe(true);
      expect(result.source).toBe("mixed");
      expect(result.sourceLabel).toContain("혼합 모드");
    });

    it("B. fixture source is NOT labeled live", () => {
      const result = renderNeuralHook({
        agents: [],
        orgUnits: [],
        sourceOverride: "fixture",
      });

      expect(result.source).toBe("fixture");
      expect(result.sourceLabel).not.toContain("운영 라이브");
      expect(result.sourceLabel).toContain("시뮬레이션 픽스처");
    });

    it("C. normalized routes map correctly to active route", () => {
      const result = renderNeuralHook({
        agents: MOCK_AGENTS,
        orgUnits: MOCK_ORG_UNITS,
        selectedAgentId: "agent-pm-1",
      });

      expect(result.activeRoute).not.toBeNull();
      expect(result.activeRoute?.executor).toBeDefined();
      expect(result.activeRoute?.provider).toBeDefined();
      expect(result.activeRoute?.model).toBeDefined();
    });

    it("D. returns empty state safely when zero agents and zero orgUnits", () => {
      const result = renderNeuralHook({
        agents: [],
        orgUnits: [],
      });

      expect(result.state).toBe("empty");
      expect(result.teams).toHaveLength(0);
      expect(result.agents).toHaveLength(0);
    });

    it("E. returns error state when error is passed", () => {
      const result = renderNeuralHook({
        agents: MOCK_AGENTS,
        orgUnits: MOCK_ORG_UNITS,
        error: new Error("Network query timeout"),
      });

      expect(result.state).toBe("error");
      expect(result.error).toBe("Network query timeout");
    });

    it("F. returns loading state when isLoading is true", () => {
      const result = renderNeuralHook({
        agents: MOCK_AGENTS,
        orgUnits: MOCK_ORG_UNITS,
        isLoading: true,
      });

      expect(result.state).toBe("loading");
    });

    it("G. sourceOverride='live' alone does NOT dismiss pending status (LIVE_MODE_IMPLEMENTED=NO)", () => {
      const result = renderNeuralHook({
        agents: MOCK_AGENTS,
        orgUnits: MOCK_ORG_UNITS,
        sourceOverride: "live",
      });

      // Crucial architectural invariant: fixture data must never pretend to be live
      expect(result.state).toBe("backend_pending");
      expect(result.backendIntegrationPending).toBe(true);
      expect(result.sourceLabel).not.toContain("운영 라이브");
      expect(result.sourceLabel).toContain("시뮬레이션 픽스처");
    });

    it("H. with a companyId and a successful backend response, switches to real live telemetry (Phase 2B MVP)", async () => {
      mockHeartbeatsApi.neuralRoutes.mockReset();
      const dto: NeuralRouteTelemetry = {
        runId: "run-live-1",
        companyId: "company-1",
        agentId: "agent-pm-1",
        routedExecutor: "codex_local",
        actualExecutor: "codex_local",
        routingReason: "tier_routing",
        status: "running",
        startedAt: "2026-10-01T00:00:00.000Z",
        source: "live",
        provider: null,
        model: null,
      };
      mockHeartbeatsApi.neuralRoutes.mockResolvedValue([dto]);

      const result = await renderNeuralHookAsync({
        agents: MOCK_AGENTS,
        orgUnits: MOCK_ORG_UNITS,
        companyId: "company-1",
      });

      expect(mockHeartbeatsApi.neuralRoutes).toHaveBeenCalledWith("company-1");
      expect(result.state).toBe("ready");
      expect(result.source).toBe("live");
      expect(result.backendIntegrationPending).toBe(false);
      expect(result.sourceLabel).toContain("실시간");
      const route = result.routesByAgentId.get("agent-pm-1");
      expect(route).toBeDefined();
      // Real agent name overlaid from the already-known `agents` prop, never
      // left at the normalizer's "Unknown Agent" placeholder.
      expect(route?.agentName).toBe("윤지우");
      expect(route?.status).toBe("running");
      expect(route?.provider).toBe("pending");
    });

    it("I. without a companyId, never calls the backend and stays fixture-only", async () => {
      mockHeartbeatsApi.neuralRoutes.mockReset();

      const result = await renderNeuralHookAsync({
        agents: MOCK_AGENTS,
        orgUnits: MOCK_ORG_UNITS,
      });

      expect(mockHeartbeatsApi.neuralRoutes).not.toHaveBeenCalled();
      expect(result.state).toBe("backend_pending");
      expect(result.backendIntegrationPending).toBe(true);
    });
  });
});
