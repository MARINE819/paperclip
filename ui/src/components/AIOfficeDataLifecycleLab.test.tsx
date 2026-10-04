// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AIOfficeDataLifecycleLab,
  ClassificationStatusBadge,
  RetentionModeBadge,
} from "./AIOfficeDataLifecycleLab";
import type {
  DataLifecycleClassificationSummary,
  DryRunResult,
} from "../api/data-lifecycle";

const mockDataLifecycleApi = vi.hoisted(() => ({
  policies: vi.fn(),
  summary: vi.fn(),
  dryRun: vi.fn(),
}));

vi.mock("../api/data-lifecycle", () => ({
  dataLifecycleApi: mockDataLifecycleApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(callback);
}

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 10));
  await Promise.resolve();
}

const SAMPLE_CLASSIFICATIONS: DataLifecycleClassificationSummary[] = [
  {
    dataClass: "audit",
    description: "General company activity/audit trail",
    status: "mapped",
    tables: [{ table: "activityLog", ageColumn: "createdAt" }],
    notes: "Append-only by design",
    policy: {
      id: "policy-1",
      dataClass: "audit",
      retentionMode: "delete",
      retentionDays: 90,
      archiveAfterDays: null,
      hardDeleteAfterDays: null,
      legalHold: false,
      enabled: true,
      source: "admin_configured",
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z",
    },
  },
  {
    dataClass: "incident",
    description: "F-06 runtime/Supervisor incidents",
    status: "mapped",
    tables: [{ table: "runtimeIncidents", ageColumn: "createdAt" }],
    notes: "runtime_incidents",
    policy: {
      id: "policy-2",
      dataClass: "incident",
      retentionMode: "archive",
      retentionDays: 30,
      archiveAfterDays: null,
      hardDeleteAfterDays: null,
      legalHold: true,
      enabled: false,
      source: "admin_configured",
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z",
    },
  },
  {
    dataClass: "memory_summary",
    description: "Summarized memory",
    status: "unmapped",
    tables: [],
    notes: "No existing table cleanly represents this",
    policy: null,
  },
  {
    dataClass: "backup_metadata",
    description: "Database backup files on disk",
    status: "file_based",
    tables: [],
    notes: "Governed today by BackupRetentionPolicy",
    policy: {
      id: "policy-3",
      dataClass: "backup_metadata",
      retentionMode: "retain",
      retentionDays: null,
      archiveAfterDays: null,
      hardDeleteAfterDays: null,
      legalHold: false,
      enabled: true,
      source: "admin_configured",
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z",
    },
  },
  {
    dataClass: "verified_knowledge",
    description: "Promoted/verified knowledge records",
    status: "mapped",
    tables: [{ table: "knowledgeRecords", ageColumn: "createdAt", archivedColumn: "archivedAt" }],
    notes: "Already has real archivedAt",
    policy: {
      id: "policy-4",
      dataClass: "verified_knowledge",
      retentionMode: "archive_then_delete",
      retentionDays: null,
      archiveAfterDays: 60,
      hardDeleteAfterDays: 365,
      legalHold: false,
      enabled: true,
      source: "admin_configured",
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z",
    },
  },
];

const SAMPLE_DRY_RUN_RESULT: DryRunResult = {
  dataClass: "audit",
  source: "activityLog",
  action: "delete",
  candidateCount: 142,
  oldestCandidate: "2026-01-01T00:00:00.000Z",
  newestCandidate: "2026-06-01T00:00:00.000Z",
  estimatedRows: 142,
  reason: "ok",
};

describe("AIOfficeDataLifecycleLab", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockDataLifecycleApi.summary.mockResolvedValue({
      classifications: SAMPLE_CLASSIFICATIONS,
    });
    mockDataLifecycleApi.dryRun.mockResolvedValue({
      result: SAMPLE_DRY_RUN_RESULT,
    });
  });

  let currentRoot: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    act(() => {
      currentRoot?.unmount();
    });
    currentRoot = null;
    container.remove();
    document.body.innerHTML = "";
    document.body.style.pointerEvents = "";
    vi.clearAllMocks();
  });

  async function renderComponent() {
    currentRoot = createRoot(container);
    act(() => {
      currentRoot!.render(
        <QueryClientProvider client={queryClient}>
          <AIOfficeDataLifecycleLab />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return currentRoot;
  }

  it("renders header and top summary statistics correctly", async () => {
    await renderComponent();

    expect(container.textContent).toContain("Control Center — Data Lifecycle & 데이터 수명관리 (F-01)");
    expect(container.textContent).toContain("전체 Data Class");
    expect(container.textContent).toContain("정책 설정됨");
    expect(container.textContent).toContain("정책 미설정");
    expect(container.textContent).toContain("Legal Hold (보존 잠금)");
    expect(container.textContent).toContain("미매핑 (Unmapped)");

    // 5 total classes in sample
    expect(container.textContent).toContain("5");
    // 4 configured policies
    expect(container.textContent).toContain("4");
    // 1 unconfigured policy
    expect(container.textContent).toContain("1");
  });

  it("renders mapped data class with connected table name", async () => {
    await renderComponent();

    expect(container.textContent).toContain("감사 로그");
    expect(container.textContent).toContain("audit");
    expect(container.textContent).toContain("activityLog");
    expect(container.textContent).toContain("90일");
  });

  it("renders unmapped memory_summary with clear hint and no fake table", async () => {
    await renderComponent();

    expect(container.textContent).toContain("요약 메모리");
    expect(container.textContent).toContain("memory_summary");
    expect(container.textContent).toContain("연결 테이블 없음");
    expect(container.textContent).toContain("아직 실제 저장 테이블과 연결되지 않음");
    expect(container.textContent).toContain("미매핑 (Unmapped)");
  });

  it("renders file_based backup_metadata as filesystem artifact", async () => {
    await renderComponent();

    expect(container.textContent).toContain("DB 백업 아티팩트");
    expect(container.textContent).toContain("backup_metadata");
    expect(container.textContent).toContain("파일 기반 (File-based)");
    expect(container.textContent).toContain("파일시스템 디렉터리");
  });

  it("renders verified_knowledge with real archivedAt support indication", async () => {
    await renderComponent();

    expect(container.textContent).toContain("검증된 사내 지식");
    expect(container.textContent).toContain("verified_knowledge");
    expect(container.textContent).toContain("archivedAt 지원");
  });

  it("renders informative empty state when 0 policies are configured without aggressive red error", async () => {
    const unconfiguredClassifications = SAMPLE_CLASSIFICATIONS.map((c) => ({
      ...c,
      policy: null,
    }));
    mockDataLifecycleApi.summary.mockResolvedValue({
      classifications: unconfiguredClassifications,
    });

    await renderComponent();

    expect(container.textContent).toContain("아직 활성화된 Data Lifecycle 정책이 없습니다.");
    expect(container.textContent).toContain("현재는 12개 데이터 분류 및 읽기 전용 Dry Run 기반만 준비된 상태입니다.");
  });

  it("renders policy status correctly for enabled, disabled, and legalHold", async () => {
    await renderComponent();

    // audit policy is enabled
    expect(container.textContent).toContain("활성 (Enabled)");
    // incident policy is disabled
    expect(container.textContent).toContain("비활성 (Disabled)");
    // incident policy has legalHold true
    expect(container.textContent).toContain("보존 잠금");
  });

  it("renders different retention modes accurately", async () => {
    await renderComponent();

    expect(container.textContent).toContain("삭제 (Delete)");
    expect(container.textContent).toContain("아카이브 (Archive)");
    expect(container.textContent).toContain("보존 유지 (Retain)");
    expect(container.textContent).toContain("영구 보존");
    expect(container.textContent).toContain("아카이브 후 삭제 (Archive → Delete)");
    expect(container.textContent).toContain("60일 / 365일");
  });

  it("opens Dry Run modal dialog when clicking Dry Run 보기 and displays candidate count", async () => {
    await renderComponent();

    const dryRunButtons = Array.from(container.querySelectorAll("button")).filter((b) =>
      b.textContent?.includes("Dry Run 보기"),
    );
    expect(dryRunButtons.length).toBeGreaterThan(0);

    act(() => {
      dryRunButtons[0]?.click();
    });
    await flushReact();
    await flushReact();

    expect(document.body.textContent).toContain("Dry Run 시뮬레이션 결과");
    expect(document.body.textContent).toContain("읽기 전용 시뮬레이션입니다");
    expect(document.body.textContent).toContain("정리 대상 후보 건수");
    expect(document.body.textContent).toContain("142건");
    expect(document.body.textContent).toContain("예상 영향 레코드");
    expect(document.body.textContent).toContain("142행");
    expect(document.body.textContent).toContain("시뮬레이션 완료 (OK)");
  });

  it("renders zero candidates with fail-closed reason when policy is missing", async () => {
    mockDataLifecycleApi.dryRun.mockResolvedValue({
      result: {
        dataClass: "memory_summary",
        source: "none",
        action: "none",
        candidateCount: 0,
        oldestCandidate: null,
        newestCandidate: null,
        estimatedRows: 0,
        reason: "no_policy_configured",
      },
    });

    await renderComponent();

    const dryRunButtons = Array.from(container.querySelectorAll("button")).filter((b) =>
      b.textContent?.includes("Dry Run 보기"),
    );
    act(() => {
      dryRunButtons[2]?.click();
    });
    await flushReact();
    await flushReact();

    expect(document.body.textContent).toContain("0건");
    expect(document.body.textContent).toContain("정책 미설정 (Fail-closed)");
    expect(document.body.textContent).toContain("안전을 위해 정리 후보 대상이 0건으로 유지됩니다");
  });

  it("handles legal hold fail-closed state in dry-run modal", async () => {
    mockDataLifecycleApi.dryRun.mockResolvedValue({
      result: {
        dataClass: "incident",
        source: "runtimeIncidents",
        action: "none",
        candidateCount: 0,
        oldestCandidate: null,
        newestCandidate: null,
        estimatedRows: 0,
        reason: "legal_hold_active",
      },
    });

    await renderComponent();

    const dryRunButtons = Array.from(container.querySelectorAll("button")).filter((b) =>
      b.textContent?.includes("Dry Run 보기"),
    );
    act(() => {
      dryRunButtons[1]?.click();
    });
    await flushReact();
    await flushReact();

    expect(document.body.textContent).toContain("보존 잠금 (Legal Hold Active)");
    expect(document.body.textContent).toContain("법적 보존 잠금(Legal Hold)이 활성화되어 있어 모든 정리가 전면 차단됩니다");
  });

  it("handles unsupported data class in dry-run modal", async () => {
    mockDataLifecycleApi.dryRun.mockResolvedValue({
      result: {
        dataClass: "memory_summary",
        source: "none",
        action: "none",
        candidateCount: 0,
        oldestCandidate: null,
        newestCandidate: null,
        estimatedRows: 0,
        reason: "unsupported_data_class",
      },
    });

    await renderComponent();

    const dryRunButtons = Array.from(container.querySelectorAll("button")).filter((b) =>
      b.textContent?.includes("Dry Run 보기"),
    );
    act(() => {
      dryRunButtons[2]?.click();
    });
    await flushReact();
    await flushReact();

    expect(document.body.textContent).toContain("미매핑 데이터 분류 (Unsupported)");
    expect(document.body.textContent).toContain("아직 실제 저장 테이블과 연결되지 않아 자동 수명관리를 지원하지 않습니다");
  });

  it("renders backup_metadata candidate count as files rather than rows", async () => {
    mockDataLifecycleApi.dryRun.mockResolvedValue({
      result: {
        dataClass: "backup_metadata",
        source: "packages/db/src/backup-lib.ts",
        action: "retain",
        candidateCount: 5,
        oldestCandidate: "2026-09-01T00:00:00.000Z",
        newestCandidate: "2026-09-25T00:00:00.000Z",
        estimatedRows: 5,
        reason: "ok",
      },
    });

    await renderComponent();

    const dryRunButtons = Array.from(container.querySelectorAll("button")).filter((b) =>
      b.textContent?.includes("Dry Run 보기"),
    );
    act(() => {
      dryRunButtons[3]?.click();
    });
    await flushReact();
    await flushReact();

    expect(document.body.textContent).toContain("5개 파일");
  });

  it("handles API failure gracefully with friendly error banner", async () => {
    mockDataLifecycleApi.summary.mockRejectedValue(new Error("Network Error"));

    await renderComponent();

    expect(container.textContent).toContain("Data Lifecycle 데이터를 불러올 수 없습니다.");
  });

  it("handles null fields with stable fallback dashes", async () => {
    const nullFieldsClassification: DataLifecycleClassificationSummary[] = [
      {
        dataClass: "audit",
        description: "Test description",
        status: "mapped",
        tables: [],
        notes: "",
        policy: null,
      },
    ];
    mockDataLifecycleApi.summary.mockResolvedValue({
      classifications: nullFieldsClassification,
    });

    await renderComponent();

    expect(container.textContent).toContain("미설정");
    expect(container.textContent).toContain("—");
  });
});

describe("ClassificationStatusBadge", () => {
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
    ["mapped", "매핑됨 (Mapped)"],
    ["unmapped", "미매핑 (Unmapped)"],
    ["file_based", "파일 기반 (File-based)"],
  ] as const)("renders status %s with label %s", (status, label) => {
    const root = createRoot(container);
    act(() => {
      root.render(<ClassificationStatusBadge status={status} />);
    });
    expect(container.textContent).toContain(label);
  });
});

describe("RetentionModeBadge", () => {
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
    ["retain", "보존 유지 (Retain)"],
    ["archive", "아카이브 (Archive)"],
    ["delete", "삭제 (Delete)"],
    ["archive_then_delete", "아카이브 후 삭제 (Archive → Delete)"],
  ] as const)("renders mode %s with label %s", (mode, label) => {
    const root = createRoot(container);
    act(() => {
      root.render(<RetentionModeBadge mode={mode} />);
    });
    expect(container.textContent).toContain(label);
  });
});
