// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AIOfficeIncidentLab,
  IncidentSeverityBadge,
  IncidentStatusBadge,
  RootCauseStatusBadge,
} from "./AIOfficeIncidentLab";
import type { RuntimeIncidentSummary } from "../api/incidents";

const mockIncidentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../api/incidents", () => ({
  incidentsApi: mockIncidentsApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(callback);
}

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

const SAMPLE_OPEN_INCIDENTS: RuntimeIncidentSummary[] = [
  {
    id: "inc-1",
    code: "windows_control_c_exit_detected",
    severity: "medium",
    status: "recovering",
    affectedComponents: ["server"],
    detectedAt: "2026-09-30T09:03:35.623Z",
    lastObservedAt: "2026-09-30T11:49:54.162Z",
    resolvedAt: null,
    occurrenceCount: 10,
    recoveryAttempted: true,
    recoveryResult: "succeeded",
    rootCauseStatus: "unknown",
    failureMemoryCandidate: false,
    fingerprint: "windows-exit-3221225786",
    evidence: [{ exitCode: 3221225786, signal: "SIGINT" }],
  },
  {
    id: "inc-2",
    code: "runtime_duplicate_detected",
    severity: "critical",
    status: "open",
    affectedComponents: ["server", "supervisor"],
    detectedAt: "2026-09-30T10:00:00.000Z",
    lastObservedAt: "2026-09-30T10:05:00.000Z",
    resolvedAt: null,
    occurrenceCount: 3,
    recoveryAttempted: false,
    recoveryResult: null,
    rootCauseStatus: "investigating",
    failureMemoryCandidate: true,
    fingerprint: "duplicate-runtime-pid-4321",
    evidence: [{ conflictingPids: [1234, 4321], port: 3100 }],
  },
];

const SAMPLE_RESOLVED_INCIDENTS: RuntimeIncidentSummary[] = [
  {
    id: "inc-3",
    code: "runtime_restart_loop",
    severity: "high",
    status: "resolved",
    affectedComponents: ["server"],
    detectedAt: "2026-09-30T08:00:00.000Z",
    lastObservedAt: "2026-09-30T08:15:00.000Z",
    resolvedAt: "2026-09-30T08:20:00.000Z",
    occurrenceCount: 4,
    recoveryAttempted: true,
    recoveryResult: "succeeded",
    rootCauseStatus: "known",
    failureMemoryCandidate: true,
    fingerprint: "restart-loop-crash",
    evidence: [{ restartCount: 4, windowSeconds: 900 }],
  },
];

describe("AIOfficeIncidentLab", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockIncidentsApi.list.mockResolvedValue({
      open: SAMPLE_OPEN_INCIDENTS,
      resolved: SAMPLE_RESOLVED_INCIDENTS,
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderComponent() {
    const root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AIOfficeIncidentLab />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  it("renders header and summary cards correctly", async () => {
    await renderComponent();

    expect(container.textContent).toContain("Control Center — Incident & SRE Center (F-06)");
    expect(container.textContent).toContain("활성 장애 (Open)");
    expect(container.textContent).toContain("1"); // inc-2 is open
    expect(container.textContent).toContain("복구 진행 중");
    expect(container.textContent).toContain("1"); // inc-1 is recovering
    expect(container.textContent).toContain("해결된 장애 (Resolved)");
    expect(container.textContent).toContain("1"); // inc-3 is resolved
    expect(container.textContent).toContain("Critical / High");
    expect(container.textContent).toContain("1"); // inc-2 is critical
    expect(container.textContent).toContain("Failure Memory 후보");
    expect(container.textContent).toContain("2"); // inc-2, inc-3
  });

  it("renders active incidents with detector label, status, and occurrence count", async () => {
    await renderComponent();

    expect(container.textContent).toContain("Active Incidents (현재 활성 장애 — 2건)");
    expect(container.textContent).toContain("Windows 0xC000013A (Control-C) 프로세스 비정상 종료");
    expect(container.textContent).toContain("중복 런타임 프로세스 감지 (포트/PID 경합)");
    expect(container.textContent).toContain("10회");
    expect(container.textContent).toContain("3회");
    expect(container.textContent).toContain("복구 중 (Recovering)");
    expect(container.textContent).toContain("열림 (Open)");
  });

  it("renders Failure Memory candidate badge when flagged by backend", async () => {
    await renderComponent();

    expect(container.textContent).toContain("Failure Memory 후보");
  });

  it("renders empty state when no open incidents exist", async () => {
    mockIncidentsApi.list.mockResolvedValue({
      open: [],
      resolved: SAMPLE_RESOLVED_INCIDENTS,
    });

    await renderComponent();

    expect(container.textContent).toContain("현재 열린 Incident 없음");
    expect(container.textContent).toContain("모든 시스템 런타임 및 Supervisor가 정상 가동 중이며 감지된 장애가 없습니다.");
  });

  it("renders resolved incidents table when expanded", async () => {
    await renderComponent();

    expect(container.textContent).toContain("과거 해결된 Incident 내역 (1건)");

    const expandBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("내역 보기"),
    );

    expect(expandBtn).toBeDefined();
    act(() => {
      expandBtn?.click();
    });
    await flushReact();

    expect(container.textContent).toContain("런타임 재시작 루프 감지 (15분 내 3회 이상)");
    expect(container.textContent).toContain("High (높음)");
    expect(container.textContent).toContain("해결됨 (Resolved)");
    expect(container.textContent).toContain("4회");
    expect(container.textContent).toContain("후보 등록");
  });

  it("opens Incident Detail Dialog when an incident is clicked", async () => {
    await renderComponent();

    const detailBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("상세 보기"),
    );
    expect(detailBtn).toBeDefined();

    act(() => {
      detailBtn?.click();
    });
    await flushReact();

    // Dialog renders into document.body
    expect(document.body.textContent).toContain("Incident 상세 정보");
    expect(document.body.textContent).toContain("SRE 런타임 스캐너가 감지하고 추적한 장애 상세 정보입니다.");
    expect(document.body.textContent).toContain("windows-exit-3221225786");
    expect(document.body.textContent).toContain("10회 반복");
    expect(document.body.textContent).toContain("시도됨");
    expect(document.body.textContent).toContain("succeeded");
    expect(document.body.textContent).toContain("원인 미확인 (UNKNOWN)");
    expect(document.body.textContent).toContain("exitCode");
  });

  it("renders API failure message gracefully", async () => {
    mockIncidentsApi.list.mockRejectedValue(new Error("Network Error"));

    await renderComponent();

    expect(container.textContent).toContain("Incident 데이터를 불러올 수 없습니다.");
  });
});

describe("IncidentStatusBadge", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it.each([
    ["open", "열림 (Open)"],
    ["recovering", "복구 중 (Recovering)"],
    ["resolved", "해결됨 (Resolved)"],
  ] as const)("renders %s with label %s", (status, label) => {
    const root = createRoot(container);
    act(() => {
      root.render(<IncidentStatusBadge status={status} />);
    });
    expect(container.textContent).toContain(label);
  });
});

describe("IncidentSeverityBadge", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it.each([
    ["critical", "Critical (치명)"],
    ["high", "High (높음)"],
    ["medium", "Medium (중간)"],
    ["low", "Low (낮음)"],
  ] as const)("renders %s with label %s", (severity, label) => {
    const root = createRoot(container);
    act(() => {
      root.render(<IncidentSeverityBadge severity={severity} />);
    });
    expect(container.textContent).toContain(label);
  });
});

describe("RootCauseStatusBadge", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it.each([
    ["known", "원인 규명됨"],
    ["investigating", "조사 중"],
    ["unknown", "원인 미확인 (UNKNOWN)"],
  ] as const)("renders %s with label %s", (status, label) => {
    const root = createRoot(container);
    act(() => {
      root.render(<RootCauseStatusBadge status={status} />);
    });
    expect(container.textContent).toContain(label);
  });
});
