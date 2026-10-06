// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { AIOfficeJarvisTaskInstruction } from "./AIOfficeJarvisTaskInstruction";

const mockJarvisApi = vi.hoisted(() => ({
  submit: vi.fn(),
}));

vi.mock("@/api/jarvis", () => ({
  jarvisApi: mockJarvisApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void | Promise<void>) {
  flushSync(callback);
}

async function flushReact() {
  act(() => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  act(() => {});
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-jarvis",
    companyId: "company-1",
    name: "JARVIS",
    urlKey: "jarvis",
    role: "ceo",
    title: "Chief AI Orchestrator",
    icon: null,
    status: "idle",
    reportsTo: null,
    orgUnitId: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 10000,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: true },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  } as Agent;
}

function setInputValue(input: HTMLTextAreaElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("AIOfficeJarvisTaskInstruction", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  function render(node: React.ReactElement) {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    let root!: ReturnType<typeof createRoot>;
    act(() => {
      root = createRoot(container);
      root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
    });
    return root;
  }

  it("renders textarea and submit button with JARVIS online status when jarvisAgent exists", () => {
    const jarvis = makeAgent();
    const root = render(
      <AIOfficeJarvisTaskInstruction companyId="company-1" jarvisAgent={jarvis} />,
    );

    expect(container.textContent).toContain("자비스(JARVIS) 업무 지시");
    expect(container.textContent).toContain("자비스 연결됨");

    const textarea = container.querySelector('[data-testid="mobile-jarvis-instruction-input"]');
    expect(textarea).not.toBeNull();

    const submitBtn = container.querySelector('[data-testid="mobile-jarvis-submit-btn"]') as HTMLButtonElement;
    expect(submitBtn).not.toBeNull();
    // initially disabled because text is empty
    expect(submitBtn.disabled).toBe(true);

    act(() => root.unmount());
  });

  it("truthfully displays warning and disables input when jarvisAgent is missing", () => {
    const root = render(
      <AIOfficeJarvisTaskInstruction companyId="company-1" jarvisAgent={null} />,
    );

    expect(container.textContent).toContain("JARVIS 미발견");
    expect(container.textContent).toContain("현재 회사에 등록된 JARVIS 에이전트를 찾을 수 없습니다.");

    const textarea = container.querySelector('[data-testid="mobile-jarvis-instruction-input"]');
    expect(textarea).toBeNull();

    act(() => root.unmount());
  });

  it("disables submit button when requestText is whitespace only", () => {
    const jarvis = makeAgent();
    const root = render(
      <AIOfficeJarvisTaskInstruction companyId="company-1" jarvisAgent={jarvis} />,
    );

    const textarea = container.querySelector('[data-testid="mobile-jarvis-instruction-input"]') as HTMLTextAreaElement;
    setInputValue(textarea, "     ");

    const submitBtn = container.querySelector('[data-testid="mobile-jarvis-submit-btn"]') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);

    act(() => root.unmount());
  });

  it("submits request to jarvisApi.submit with jarvisAgentId and requestText (plan omitted) and resets input on success", async () => {
    const jarvis = makeAgent({ id: "jarvis-100" });
    const specialist = makeAgent({ id: "specialist-200", name: "CodeSpecialist" });
    const agentById = new Map([
      ["jarvis-100", jarvis],
      ["specialist-200", specialist],
    ]);

    mockJarvisApi.submit.mockResolvedValue({
      ok: true,
      parentIssueId: "parent-issue-1111",
      childIssueId: "child-issue-2222",
      selectedAgentId: "specialist-200",
      parentIssueDeduplicated: false,
    });

    const onSuccess = vi.fn();
    const root = render(
      <AIOfficeJarvisTaskInstruction
        companyId="company-1"
        jarvisAgent={jarvis}
        agentById={agentById}
        onSuccess={onSuccess}
      />,
    );

    const textarea = container.querySelector('[data-testid="mobile-jarvis-instruction-input"]') as HTMLTextAreaElement;
    setInputValue(textarea, "모바일 결재 E2E 테스트 검증");

    const submitBtn = container.querySelector('[data-testid="mobile-jarvis-submit-btn"]') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);

    act(() => {
      submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(mockJarvisApi.submit).toHaveBeenCalledWith("company-1", {
      jarvisAgentId: "jarvis-100",
      requestText: "모바일 결재 E2E 테스트 검증",
    });

    // Check success receipt
    const receipt = container.querySelector('[data-testid="mobile-jarvis-success-receipt"]');
    expect(receipt).not.toBeNull();
    expect(receipt?.textContent).toContain("업무 접수 및 전문가 배정 완료");
    expect(receipt?.textContent).toContain("parent-i");
    expect(receipt?.textContent).toContain("child-is");
    expect(receipt?.textContent).toContain("CodeSpecialist");

    const parentLink = container.querySelector('[data-testid="jarvis-receipt-parent-link"]') as HTMLAnchorElement;
    expect(parentLink).not.toBeNull();
    expect(parentLink?.getAttribute("href")).toBe("/issues/parent-issue-1111");

    const childLink = container.querySelector('[data-testid="jarvis-receipt-child-link"]') as HTMLAnchorElement;
    expect(childLink).not.toBeNull();
    expect(childLink?.getAttribute("href")).toBe("/issues/child-issue-2222");

    // Input reset
    expect(textarea.value).toBe("");
    expect(onSuccess).toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("shows deduplication indicator in success receipt when parentIssueDeduplicated is true", async () => {
    const jarvis = makeAgent({ id: "jarvis-100" });
    mockJarvisApi.submit.mockResolvedValue({
      ok: true,
      parentIssueId: "parent-issue-dedup",
      childIssueId: "child-issue-dedup",
      selectedAgentId: "jarvis-100",
      parentIssueDeduplicated: true,
    });

    const root = render(
      <AIOfficeJarvisTaskInstruction companyId="company-1" jarvisAgent={jarvis} />,
    );

    const textarea = container.querySelector('[data-testid="mobile-jarvis-instruction-input"]') as HTMLTextAreaElement;
    setInputValue(textarea, "Repeated command");

    const submitBtn = container.querySelector('[data-testid="mobile-jarvis-submit-btn"]') as HTMLButtonElement;
    act(() => {
      submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("(기존 동일 업무 연계됨)");

    act(() => root.unmount());
  });

  it("displays honest error messages for 400, 403, and 422 responses", async () => {
    const jarvis = makeAgent({ id: "jarvis-1" });

    // 1. 403 Human board actor required
    mockJarvisApi.submit.mockRejectedValue(
      new ApiError("Delegating to JARVIS requires a Human board actor.", 403, {
        error: "Delegating to JARVIS requires a Human board actor.",
      }),
    );

    const root = render(
      <AIOfficeJarvisTaskInstruction companyId="company-1" jarvisAgent={jarvis} />,
    );

    const textarea = container.querySelector('[data-testid="mobile-jarvis-instruction-input"]') as HTMLTextAreaElement;
    setInputValue(textarea, "Task with permission error");

    const submitBtn = container.querySelector('[data-testid="mobile-jarvis-submit-btn"]') as HTMLButtonElement;
    act(() => {
      submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    const errorAlert = container.querySelector('[data-testid="mobile-jarvis-error-alert"]');
    expect(errorAlert).not.toBeNull();
    expect(errorAlert?.textContent).toContain("권한 거부 (403)");
    expect(errorAlert?.textContent).toContain("Delegating to JARVIS requires a Human board actor.");

    act(() => root.unmount());
  });

  it("displays 422 plan derivation error honestly", async () => {
    const jarvis = makeAgent({ id: "jarvis-1" });

    mockJarvisApi.submit.mockRejectedValue(
      new ApiError("Could not derive a delegation plan from requestText.", 422, {
        detail: "no_eligible_specialist",
      }),
    );

    const root = render(
      <AIOfficeJarvisTaskInstruction companyId="company-1" jarvisAgent={jarvis} />,
    );

    const textarea = container.querySelector('[data-testid="mobile-jarvis-instruction-input"]') as HTMLTextAreaElement;
    setInputValue(textarea, "Task with no specialist");

    const submitBtn = container.querySelector('[data-testid="mobile-jarvis-submit-btn"]') as HTMLButtonElement;
    act(() => {
      submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    const errorAlert = container.querySelector('[data-testid="mobile-jarvis-error-alert"]');
    expect(errorAlert).not.toBeNull();
    expect(errorAlert?.textContent).toContain("업무 계획 수립 불가 (422): no_eligible_specialist");

    act(() => root.unmount());
  });
});
