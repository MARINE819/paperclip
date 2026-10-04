// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AIOfficeKnowledgeLab } from "./AIOfficeKnowledgeLab";
import type { MemoryOperationItem, KnowledgeRecordItem } from "../api/knowledge";

const mockKnowledgeApi = vi.hoisted(() => ({
  listMemoryOperations: vi.fn(),
  getMemoryOperation: vi.fn(),
  reviewMemoryOperation: vi.fn(),
  promoteMemoryOperation: vi.fn(),
  listKnowledgeRecords: vi.fn(),
  getKnowledgeRecord: vi.fn(),
  syncKnowledgeRecord: vi.fn(),
}));

vi.mock("../api/knowledge", () => ({
  knowledgeApi: mockKnowledgeApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(callback);
}

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 20));
  await Promise.resolve();
}

const SAMPLE_CANDIDATES: MemoryOperationItem[] = [
  {
    id: "mem-1",
    companyId: "company-1",
    sourceType: "issue",
    sourceId: "issue-101",
    sourceIssueId: "issue-101",
    sourceRunId: null,
    sourceAgentId: "agent-1",
    title: "Stage 7 모델 라우터 장애 격리 정책",
    summary: "모델 라우터에서 no_route 발생 시 fail-closed 전략 적용",
    content: "모델 라우터는 어댑터 간 모델 누수를 방지하기 위해 fail-closed 모델을 채택합니다.",
    confidence: 0.92,
    status: "candidate",
    reviewState: "pending",
    reviewedByAgentId: null,
    reviewNotes: null,
    approvalId: null,
    extractionKey: "ext-1",
    metadata: { author: "Codex" },
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
  },
  {
    id: "mem-2",
    companyId: "company-1",
    sourceType: "run",
    sourceId: "run-202",
    sourceIssueId: null,
    sourceRunId: "run-202",
    sourceAgentId: "agent-2",
    title: "Playwright E2E 포트 격리 규칙",
    summary: "E2E 테스트 시 포트 3199를 사용하며 운영 3100에 영향을 주지 않음",
    content: "Playwright E2E 실행 시 반드시 isolated 포트 3199와 임시 DB를 사용하여 운영 환경을 보호합니다.",
    confidence: 0.85,
    status: "candidate",
    reviewState: "approved",
    reviewedByAgentId: null,
    reviewNotes: "CEO 사전 승인 완료",
    approvalId: null,
    extractionKey: "ext-2",
    metadata: {},
    createdAt: "2026-10-01T09:30:00.000Z",
    updatedAt: "2026-10-01T09:40:00.000Z",
  },
  {
    id: "mem-3",
    companyId: "company-1",
    sourceType: "work_product",
    sourceId: "doc-303",
    sourceIssueId: null,
    sourceRunId: null,
    sourceAgentId: "agent-3",
    title: "임시 데이터 정리 가이드",
    summary: "과거 스크래치 파일 보관 주기",
    content: "임시 파일은 7일 후 보존 주기에 따라 정리됩니다.",
    confidence: 0.45,
    status: "rejected",
    reviewState: "rejected",
    reviewedByAgentId: null,
    reviewNotes: "중복 문서로 판단하여 반려",
    approvalId: null,
    extractionKey: "ext-3",
    metadata: {},
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:15:00.000Z",
  },
  {
    id: "mem-4",
    companyId: "company-1",
    sourceType: "document",
    sourceId: "doc-404",
    sourceIssueId: null,
    sourceRunId: null,
    sourceAgentId: null,
    title: "F-04 에이전트 평가 벤치마크 규약",
    summary: "에이전트 벤치마크 케이스 구성안",
    content: "에이전트 품질 시뮬레이션을 위한 벤치마크 케이스 표준 스키마.",
    confidence: 0.88,
    status: "promoted",
    reviewState: "approved",
    reviewedByAgentId: null,
    reviewNotes: null,
    approvalId: null,
    extractionKey: "ext-4",
    metadata: {},
    createdAt: "2026-09-30T15:00:00.000Z",
    updatedAt: "2026-09-30T16:00:00.000Z",
  },
];

const SAMPLE_RECORDS: KnowledgeRecordItem[] = [
  {
    id: "rec-1",
    companyId: "company-1",
    knowledgeType: "architecture",
    title: "NEXORA Master 2 거버넌스 아키텍처",
    summary: "단일 승인 게이트와 자동 저장 동기화",
    body: "# NEXORA Master 2 Architecture\n\n모든 거버넌스 행동은 회사의 승인 게이트를 통과해야 합니다.",
    metadata: {
      provenance: {
        sourceType: "issue",
        sourceId: "issue-101",
        memoryOperationId: "mem-4",
        capturedAt: "2026-09-30T16:00:00.000Z",
      },
    },
    sourceMemoryOperationId: "mem-4",
    sourceIssueId: "issue-101",
    sourceRunId: null,
    sourceAgentId: null,
    status: "active",
    obsidianPath: "Knowledge/Architecture/Master-2-Governance.md",
    obsidianSyncState: "synced",
    obsidianSyncError: null,
    obsidianSyncedAt: "2026-09-30T16:05:00.000Z",
    externalBackendId: "obsidian",
    externalSyncState: "synced",
    externalSyncError: null,
    externalSyncedAt: "2026-09-30T16:05:00.000Z",
    externalRef: "Knowledge/Architecture/Master-2-Governance.md",
    createdAt: "2026-09-30T16:00:00.000Z",
    updatedAt: "2026-09-30T16:05:00.000Z",
    archivedAt: null,
  },
  {
    id: "rec-2",
    companyId: "company-1",
    knowledgeType: "policy",
    title: "보안 토큰 마스킹 정책",
    summary: "해시 기반 비가역적 식별자 표출",
    body: "비밀값은 절대 브라우저나 UI에 노출되지 않으며 해시 파생 마스킹 문자열만 표출합니다.",
    metadata: {},
    sourceMemoryOperationId: null,
    sourceIssueId: null,
    sourceRunId: null,
    sourceAgentId: null,
    status: "active",
    obsidianPath: null,
    obsidianSyncState: "failed",
    obsidianSyncError: "Error writing to C:\\Obsidian\\Vault\\policy.md: EACCES permission denied\n  at writeFileSync (fs.js:123)",
    obsidianSyncedAt: null,
    externalBackendId: "obsidian",
    externalSyncState: "failed",
    externalSyncError: "Error writing to C:\\Obsidian\\Vault\\policy.md: EACCES permission denied\n  at writeFileSync (fs.js:123)",
    externalSyncedAt: null,
    externalRef: null,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:05:00.000Z",
    archivedAt: null,
  },
];

describe("AIOfficeKnowledgeLab", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    mockKnowledgeApi.listMemoryOperations.mockResolvedValue([...SAMPLE_CANDIDATES]);
    mockKnowledgeApi.listKnowledgeRecords.mockResolvedValue([...SAMPLE_RECORDS]);
    mockKnowledgeApi.reviewMemoryOperation.mockImplementation(async (id: string, params: { reviewState: "approved" | "rejected"; reviewNotes?: string }) => {
      const found = SAMPLE_CANDIDATES.find((c) => c.id === id);
      return {
        ...found!,
        reviewState: params.reviewState,
        status: params.reviewState === "rejected" ? "rejected" : found!.status,
        reviewNotes: params.reviewNotes ?? null,
      };
    });
    mockKnowledgeApi.promoteMemoryOperation.mockImplementation(async (id: string, params: { title?: string; knowledgeType?: string }) => {
      const found = SAMPLE_CANDIDATES.find((c) => c.id === id);
      const promotedOp: MemoryOperationItem = { ...found!, status: "promoted" };
      const newRec: KnowledgeRecordItem = {
        id: `rec-promoted-${Date.now()}`,
        companyId: "company-1",
        knowledgeType: params.knowledgeType ?? "architecture",
        title: params.title ?? found!.title ?? "New Knowledge",
        summary: found!.summary,
        body: found!.content,
        metadata: {},
        sourceMemoryOperationId: id,
        sourceIssueId: found!.sourceIssueId,
        sourceRunId: found!.sourceRunId,
        sourceAgentId: found!.sourceAgentId,
        status: "active",
        obsidianPath: null,
        obsidianSyncState: "pending",
        obsidianSyncError: null,
        obsidianSyncedAt: null,
        externalBackendId: "obsidian",
        externalSyncState: "pending",
        externalSyncError: null,
        externalSyncedAt: null,
        externalRef: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archivedAt: null,
      };
      return { operation: promotedOp, knowledgeRecord: newRec };
    });
    mockKnowledgeApi.syncKnowledgeRecord.mockImplementation(async (id: string) => {
      const found = SAMPLE_RECORDS.find((r) => r.id === id);
      return {
        ...found!,
        externalSyncState: "synced",
        obsidianSyncState: "synced",
        externalSyncError: null,
        obsidianSyncError: null,
        externalSyncedAt: new Date().toISOString(),
      };
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  function render(companyId = "company-1") {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AIOfficeKnowledgeLab companyId={companyId} />
        </QueryClientProvider>,
      );
    });
  }

  it("renders 5 summary KPI cards with correct metrics", async () => {
    render();
    await flushReact();

    const candidatesCount = container.querySelector('[data-testid="summary-total-candidates"]');
    const pendingCount = container.querySelector('[data-testid="summary-pending-review"]');
    const approvedCount = container.querySelector('[data-testid="summary-approved-candidates"]');
    const recordsCount = container.querySelector('[data-testid="summary-total-records"]');
    const syncFailures = container.querySelector('[data-testid="summary-sync-failures"]');

    expect(candidatesCount?.textContent?.trim()).toBe("4");
    expect(pendingCount?.textContent?.trim()).toBe("1"); // mem-1 is pending
    expect(approvedCount?.textContent?.trim()).toBe("1"); // mem-2 is approved candidate
    expect(recordsCount?.textContent?.trim()).toBe("2");
    expect(syncFailures?.textContent?.trim()).toBe("1"); // rec-2 is failed
  });

  it("renders candidate rows with source type, confidence, and review state badges", async () => {
    render();
    await flushReact();

    expect(container.textContent).toContain("Stage 7 모델 라우터 장애 격리 정책");
    expect(container.textContent).toContain("Playwright E2E 포트 격리 규칙");
    expect(container.textContent).toContain("92%");
    expect(container.textContent).toContain("검토 대기");
    expect(container.textContent).toContain("검토 승인");
    expect(container.textContent).toContain("승격 완료");
  });

  it("filters candidates by review status", async () => {
    render();
    await flushReact();

    const pendingFilterBtn = container.querySelector('[data-testid="filter-candidate-pending"]') as HTMLButtonElement;
    expect(pendingFilterBtn).toBeTruthy();

    act(() => {
      pendingFilterBtn.click();
    });
    await flushReact();

    expect(container.textContent).toContain("Stage 7 모델 라우터 장애 격리 정책");
    expect(container.textContent).not.toContain("Playwright E2E 포트 격리 규칙");
  });

  it("filters candidates by search input", async () => {
    render();
    await flushReact();

    const searchInput = container.querySelector('[data-testid="candidate-search-input"]') as HTMLInputElement;
    expect(searchInput).toBeTruthy();

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(searchInput, "Playwright");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      searchInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Playwright E2E 포트 격리 규칙");
    expect(container.textContent).not.toContain("Stage 7 모델 라우터 장애 격리 정책");
  });

  it("opens review dialog for pending candidate and handles approval", async () => {
    render();
    await flushReact();

    const reviewBtn = container.querySelector('[data-testid="btn-review-mem-1"]') as HTMLButtonElement;
    expect(reviewBtn).toBeTruthy();

    act(() => {
      reviewBtn.click();
    });
    await flushReact();

    // Dialog should be open
    expect(document.body.textContent).toContain("후보 메모리 검토 (Review)");
    expect(document.body.textContent).toContain("Stage 7 모델 라우터 장애 격리 정책");

    const approveBtn = document.body.querySelector('[data-testid="modal-approve-btn"]') as HTMLButtonElement;
    expect(approveBtn).toBeTruthy();

    act(() => {
      approveBtn.click();
    });
    await flushReact();

    expect(mockKnowledgeApi.reviewMemoryOperation).toHaveBeenCalledWith("mem-1", {
      reviewState: "approved",
      reviewNotes: undefined,
    });
  });

  it("handles rejection with candidate rejection wording (never permanent delete)", async () => {
    render();
    await flushReact();

    const reviewBtn = container.querySelector('[data-testid="btn-review-mem-1"]') as HTMLButtonElement;
    act(() => {
      reviewBtn.click();
    });
    await flushReact();

    const rejectBtn = document.body.querySelector('[data-testid="modal-reject-btn"]') as HTMLButtonElement;
    expect(rejectBtn).toBeTruthy();
    expect(rejectBtn.textContent).toContain("후보 반려");
    expect(rejectBtn.textContent).not.toContain("영구 삭제");

    act(() => {
      rejectBtn.click();
    });
    await flushReact();

    expect(mockKnowledgeApi.reviewMemoryOperation).toHaveBeenCalledWith("mem-1", {
      reviewState: "rejected",
      reviewNotes: undefined,
    });
  });

  it("shows promote button only when reviewState is approved and candidate is not promoted yet", async () => {
    render();
    await flushReact();

    // mem-1 is pending: no promote button
    expect(container.querySelector('[data-testid="btn-promote-mem-1"]')).toBeNull();

    // mem-2 is approved: promote button exists
    const promoteBtn = container.querySelector('[data-testid="btn-promote-mem-2"]') as HTMLButtonElement;
    expect(promoteBtn).toBeTruthy();
    expect(promoteBtn.textContent).toContain("지식 승격");

    // mem-4 is already promoted: no promote button
    expect(container.querySelector('[data-testid="btn-promote-mem-4"]')).toBeNull();
  });

  it("opens promote modal and executes promotion with single approval gate", async () => {
    render();
    await flushReact();

    const promoteBtn = container.querySelector('[data-testid="btn-promote-mem-2"]') as HTMLButtonElement;
    act(() => {
      promoteBtn.click();
    });
    await flushReact();

    expect(document.body.textContent).toContain("공식 사내 지식으로 승격 (Promote)");
    expect(document.body.textContent).toContain("F-07 Single Approval Gate");

    const confirmPromoteBtn = document.body.querySelector('[data-testid="modal-confirm-promote-btn"]') as HTMLButtonElement;
    expect(confirmPromoteBtn).toBeTruthy();

    act(() => {
      confirmPromoteBtn.click();
    });
    await flushReact();

    expect(mockKnowledgeApi.promoteMemoryOperation).toHaveBeenCalledWith(
      "mem-2",
      expect.objectContaining({
        title: "Playwright E2E 포트 격리 규칙",
      }),
    );
  });

  it("switches to knowledge records tab and displays records", async () => {
    render();
    await flushReact();

    const recordsTabBtn = container.querySelector('[data-testid="tab-records-btn"]') as HTMLButtonElement;
    expect(recordsTabBtn).toBeTruthy();

    act(() => {
      recordsTabBtn.click();
    });
    await flushReact();

    expect(container.textContent).toContain("NEXORA Master 2 거버넌스 아키텍처");
    expect(container.textContent).toContain("보안 토큰 마스킹 정책");
    expect(container.textContent).toContain("동기화 완료");
    expect(container.textContent).toContain("동기화 실패");
  });

  it("sanitizes sync error and allows sync retry", async () => {
    render();
    await flushReact();

    // Switch to records tab
    act(() => {
      (container.querySelector('[data-testid="tab-records-btn"]') as HTMLButtonElement).click();
    });
    await flushReact();

    const retryBtn = container.querySelector('[data-testid="btn-sync-retry-rec-2"]') as HTMLButtonElement;
    expect(retryBtn).toBeTruthy();

    act(() => {
      retryBtn.click();
    });
    await flushReact();

    expect(mockKnowledgeApi.syncKnowledgeRecord).toHaveBeenCalledWith("rec-2");
  });

  it("sanitizes internal paths and stack traces in record detail dialog", async () => {
    render();
    await flushReact();

    // Switch to records tab
    act(() => {
      (container.querySelector('[data-testid="tab-records-btn"]') as HTMLButtonElement).click();
    });
    await flushReact();

    const detailBtn = container.querySelector('[data-testid="btn-record-detail-rec-2"]') as HTMLButtonElement;
    act(() => {
      detailBtn.click();
    });
    await flushReact();

    expect(document.body.textContent).toContain("사내 공식 지식 상세");
    expect(document.body.textContent).toContain("동기화 오류 메시지 (정제됨)");

    // Raw Windows absolute path C:\Obsidian\Vault should be sanitized
    expect(document.body.textContent).not.toContain("C:\\Obsidian\\Vault\\policy.md");
    // JS stack trace should be removed
    expect(document.body.textContent).not.toContain("at writeFileSync");
  });

  it("renders empty states when no data is returned", async () => {
    mockKnowledgeApi.listMemoryOperations.mockResolvedValue([]);
    mockKnowledgeApi.listKnowledgeRecords.mockResolvedValue([]);

    render();
    await flushReact();

    expect(container.querySelector('[data-testid="candidate-empty-state"]')).toBeTruthy();

    // Switch to records tab
    act(() => {
      (container.querySelector('[data-testid="tab-records-btn"]') as HTMLButtonElement).click();
    });
    await flushReact();

    expect(container.querySelector('[data-testid="record-empty-state"]')).toBeTruthy();
  });

  it("renders error banner when API fails", async () => {
    mockKnowledgeApi.listMemoryOperations.mockRejectedValue(new Error("Database connection lost"));

    render();
    await flushReact();

    expect(container.textContent).toContain("지식 데이터 조회 실패");
  });
});
