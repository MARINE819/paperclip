// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Approval, Issue, IssueComment } from "@paperclipai/shared";
import { AIOfficeCeoControlRail } from "./AIOfficeCeoControlRail";

const mockApprovalsApi = vi.hoisted(() => ({
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  update: vi.fn(),
}));

vi.mock("@/api/approvals", () => ({
  approvalsApi: mockApprovalsApi,
}));

vi.mock("@/api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("@/components/DecisionQueueRail", () => ({
  DecisionQueueRail: ({ companyId }: { companyId: string }) => (
    <div data-testid="mock-decision-queue-rail">DecisionQueueRail: {companyId}</div>
  ),
}));

vi.mock("@/components/ActivityFeed", () => ({
  ActivityFeed: () => <div data-testid="mock-activity-feed">ActivityFeed</div>,
}));

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Alpha",
    role: "general",
    title: "Engineering Lead",
    status: "idle",
    reportsTo: null,
    orgUnitId: null,
    adapterType: "codex_local",
    adapterConfig: {},
    spentMonthlyCents: 0,
    lastHeartbeatAt: new Date("2026-01-01T00:00:00Z"),
    errorReason: null,
    pauseReason: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as Agent;
}

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    requestedByAgentId: "agent-1",
    requestedByUserId: null,
    status: "pending",
    payload: { note: "Requesting server budget increase" },
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as Approval;
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: "proj-1",
    projectWorkspaceId: "ws-1",
    parentId: null,
    identifier: "PAP-101",
    title: "Implement Realtime WebSocket Invalidation",
    description: "Connect to company events ws",
    status: "in_review",
    priority: "high",
    type: "feature",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    reporterAgentId: null,
    reporterUserId: "user-1",
    originKind: "human",
    originKindPrefix: null,
    originId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as Issue;
}

async function flushReact() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("AIOfficeCeoControlRail", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;
  const onSelectAgentMock = vi.fn();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockApprovalsApi.approve.mockResolvedValue({});
    mockApprovalsApi.reject.mockResolvedValue({});
    mockApprovalsApi.requestRevision.mockResolvedValue({});
    mockIssuesApi.update.mockResolvedValue({});
    onSelectAgentMock.mockClear();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  function renderRail(props: Partial<Parameters<typeof AIOfficeCeoControlRail>[0]> = {}) {
    const root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AIOfficeCeoControlRail
            companyId="company-1"
            allPendingApprovals={[]}
            inReviewIssues={[]}
            completedIssues={[]}
            blockedOrOfflineAgents={[]}
            agents={[]}
            onSelectAgent={onSelectAgentMock}
            {...props}
          />
        </QueryClientProvider>,
      );
    });
    return root;
  }

  it("renders empty states gracefully across all sections", () => {
    const root = renderRail();

    expect(container.textContent).toContain("검토 대기 (In-Review) (0건)");
    expect(container.textContent).toContain("검토 대기 중인 업무 없음");

    expect(container.textContent).toContain("승인 대기 (0건)");
    expect(container.textContent).toContain("대기 중인 승인 없음");

    expect(container.textContent).toContain("블로커 센터");
    expect(container.textContent).toContain("차단/오프라인 에이전트 없음");

    expect(container.textContent).toContain("최근 완료 업무 (0건)");
    expect(container.textContent).toContain("완료된 업무 없음");

    act(() => root.unmount());
  });

  it("renders in-review issues with jarvis final report badge and executes Done acceptance", async () => {
    const agent = makeAgent({ id: "agent-1", name: "Alpha" });
    const issue = makeIssue({ id: "issue-1", identifier: "PAP-101", title: "Test Issue", assigneeAgentId: "agent-1" });
    const jarvisComment = {
      id: "comment-1",
      metadata: { authorizationReason: "canonical_jarvis_parent_report" },
    } as unknown as IssueComment;
    const reportMap = new Map([["issue-1", jarvisComment]]);

    const root = renderRail({
      inReviewIssues: [issue],
      agents: [agent],
      jarvisReportCommentByIssueId: reportMap,
    });

    expect(container.textContent).toContain("검토 대기 (In-Review) (1건)");
    expect(container.textContent).toContain("PAP-101");
    expect(container.textContent).toContain("Test Issue");
    expect(container.textContent).toContain("JARVIS 최종 보고");
    expect(container.textContent).toContain("담당: Alpha");

    const acceptBtn = container.querySelector(
      '[data-testid="desktop-in-review-accept-btn-issue-1"]',
    ) as HTMLButtonElement;
    expect(acceptBtn).not.toBeNull();

    act(() => {
      acceptBtn.click();
    });
    await flushReact();

    expect(mockIssuesApi.update).toHaveBeenCalledWith("issue-1", { status: "done" });

    act(() => root.unmount());
  });

  it("opens rework modal and submits rework comment to send issue back to todo", async () => {
    const agent = makeAgent({ id: "agent-1", name: "Alpha" });
    const issue = makeIssue({ id: "issue-1", identifier: "PAP-101", title: "Test Issue", assigneeAgentId: "agent-1" });

    const root = renderRail({
      inReviewIssues: [issue],
      agents: [agent],
    });

    const reworkBtn = container.querySelector(
      '[data-testid="desktop-in-review-rework-btn-issue-1"]',
    ) as HTMLButtonElement;
    expect(reworkBtn).not.toBeNull();

    act(() => {
      reworkBtn.click();
    });
    await flushReact();

    expect(document.body.textContent).toContain("업무 재작업 지시 (Rework)");

    const textarea = document.body.querySelector(
      '[data-testid="desktop-rework-comment-input"]',
    ) as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();

    act(() => {
      setNativeValue(textarea, "Please add more unit tests before merging.");
    });
    await flushReact();

    const submitBtn = document.body.querySelector(
      '[data-testid="desktop-modal-submit-rework-btn"]',
    ) as HTMLButtonElement;
    expect(submitBtn).not.toBeNull();

    act(() => {
      submitBtn.click();
    });
    await flushReact();

    expect(mockIssuesApi.update).toHaveBeenCalledWith("issue-1", {
      status: "todo",
      comment: "Please add more unit tests before merging.",
    });

    act(() => root.unmount());
  });

  it("handles quick approval and quick reject for pending approvals", async () => {
    const approval = makeApproval({ id: "approval-1", type: "budget_override_required" });
    const root = renderRail({
      allPendingApprovals: [approval],
    });

    expect(container.textContent).toContain("승인 대기 (1건)");
    expect(container.textContent).toContain("budget_override_required");

    const quickApproveBtn = container.querySelector(
      '[data-testid="desktop-approval-quick-approve-approval-1"]',
    ) as HTMLButtonElement;
    expect(quickApproveBtn).not.toBeNull();

    act(() => {
      quickApproveBtn.click();
    });
    await flushReact();

    expect(mockApprovalsApi.approve).toHaveBeenCalledWith("approval-1", undefined);

    const quickRejectBtn = container.querySelector(
      '[data-testid="desktop-approval-quick-reject-approval-1"]',
    ) as HTMLButtonElement;
    expect(quickRejectBtn).not.toBeNull();

    act(() => {
      quickRejectBtn.click();
    });
    await flushReact();

    expect(mockApprovalsApi.reject).toHaveBeenCalledWith("approval-1", undefined);

    act(() => root.unmount());
  });

  it("opens approval review dialog and submits revision requested with note", async () => {
    const approval = makeApproval({ id: "approval-1", type: "request_board_approval" });
    const root = renderRail({
      allPendingApprovals: [approval],
    });

    const revisionBtn = container.querySelector(
      '[data-testid="desktop-approval-request-revision-approval-1"]',
    ) as HTMLButtonElement;
    expect(revisionBtn).not.toBeNull();

    act(() => {
      revisionBtn.click();
    });
    await flushReact();

    expect(document.body.textContent).toContain("결재 신속 검토");

    const textarea = document.body.querySelector(
      '[data-testid="desktop-approval-note-input"]',
    ) as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();

    act(() => {
      setNativeValue(textarea, "Claude Opus is too costly; please switch to Sonnet 3.5.");
    });
    await flushReact();

    const submitRevisionBtn = document.body.querySelector(
      '[data-testid="desktop-modal-request-revision-btn"]',
    ) as HTMLButtonElement;
    expect(submitRevisionBtn).not.toBeNull();

    act(() => {
      submitRevisionBtn.click();
    });
    await flushReact();

    expect(mockApprovalsApi.requestRevision).toHaveBeenCalledWith(
      "approval-1",
      "Claude Opus is too costly; please switch to Sonnet 3.5.",
    );

    act(() => root.unmount());
  });

  it("renders blocker center with error/offline agents and invokes onSelectAgent on click", async () => {
    const brokenAgent = makeAgent({ id: "broken-1", name: "BrokenAgent" });
    const root = renderRail({
      blockedOrOfflineAgents: [{ agent: brokenAgent, condition: "error" }],
    });

    expect(container.textContent).toContain("블로커 센터");
    expect(container.textContent).toContain("BrokenAgent");

    const blockerBtn = container.querySelector(
      '[data-testid="desktop-blocker-item-broken-1"]',
    ) as HTMLButtonElement;
    expect(blockerBtn).not.toBeNull();

    act(() => {
      blockerBtn.click();
    });
    await flushReact();

    expect(onSelectAgentMock).toHaveBeenCalledWith("broken-1");

    act(() => root.unmount());
  });
});
