// @vitest-environment jsdom

import { act, forwardRef } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileApprovalConsole } from "./MobileApprovalConsole";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockNavigate = vi.fn();
const mockBreadcrumbs = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
}));

const mockApprovalsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockCompaniesApi = vi.hoisted(() => ({
  emergencyPause: vi.fn(),
  emergencyResume: vi.fn(),
}));

const mockHealthApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

const mockWebauthnApi = vi.hoisted(() => ({
  getAuthenticationOptions: vi.fn(),
  verifyAuthentication: vi.fn(),
}));

const mockSimpleWebauthn = vi.hoisted(() => ({
  startAuthentication: vi.fn(),
  browserSupportsWebAuthn: vi.fn(),
}));

interface MockCompany {
  id: string;
  name: string;
  status: "active" | "paused";
}

let mockCurrentCompany: MockCompany | null = {
  id: "company-1",
  name: "Acme Corp",
  status: "active",
};

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
  Link: forwardRef<
    HTMLAnchorElement,
    React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }
  >(({ to, children, ...props }, ref) => (
    <a ref={ref} href={to} {...props}>
      {children}
    </a>
  )),
}));

vi.mock("../../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => mockBreadcrumbs,
}));

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: mockCurrentCompany ? mockCurrentCompany.id : null,
    selectedCompany: mockCurrentCompany,
  }),
}));

vi.mock("../../api/approvals", () => ({
  approvalsApi: mockApprovalsApi,
}));

vi.mock("../../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

vi.mock("../../api/health", () => ({
  healthApi: mockHealthApi,
}));

vi.mock("../../api/webauthn", () => ({
  webauthnApi: mockWebauthnApi,
}));

vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: mockSimpleWebauthn.startAuthentication,
  browserSupportsWebAuthn: mockSimpleWebauthn.browserSupportsWebAuthn,
}));

async function flushUi() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("MobileApprovalConsole Emergency Pause & Resume UI Pipeline (6 Core Scenarios)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    mockCurrentCompany = {
      id: "company-1",
      name: "Acme Corp",
      status: "active",
    };

    mockHealthApi.get.mockResolvedValue({ status: "ok" });
    mockApprovalsApi.list.mockResolvedValue([]);
    mockSimpleWebauthn.browserSupportsWebAuthn.mockReturnValue(true);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function renderComponent() {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MobileApprovalConsole />
        </QueryClientProvider>,
      );
    });
  }

  // ── Scenario 1: Renders emergency toggle button based on company status ────────
  it("Scenario 1a: Renders '즉시 긴급 중지' button when company status is active", async () => {
    mockCurrentCompany = {
      id: "company-1",
      name: "Acme Corp",
      status: "active",
    };

    renderComponent();
    await flushUi();

    const buttons = Array.from(container.querySelectorAll("button"));
    const pauseButton = buttons.find((b) => b.textContent?.includes("즉시 긴급 중지"));
    expect(pauseButton).toBeDefined();
  });

  it("Scenario 1b: Renders '긴급 중지 해제' button when company status is paused", async () => {
    mockCurrentCompany = {
      id: "company-1",
      name: "Acme Corp",
      status: "paused",
    };

    renderComponent();
    await flushUi();

    const buttons = Array.from(container.querySelectorAll("button"));
    const resumeButton = buttons.find((b) => b.textContent?.includes("긴급 중지 해제"));
    expect(resumeButton).toBeDefined();
  });

  // ── Scenario 2: Emergency Pause calls companiesApi.emergencyPause when active ──
  it("Scenario 2: Emergency Pause calls companiesApi.emergencyPause when active", async () => {
    mockCurrentCompany = {
      id: "company-1",
      name: "Acme Corp",
      status: "active",
    };
    mockCompaniesApi.emergencyPause.mockResolvedValue({
      id: "company-1",
      name: "Acme Corp",
      status: "paused",
    });

    renderComponent();
    await flushUi();

    const buttons = Array.from(container.querySelectorAll("button"));
    const pauseButton = buttons.find((b) => b.textContent?.includes("즉시 긴급 중지"));
    expect(pauseButton).toBeDefined();

    await act(async () => {
      pauseButton?.click();
    });
    await flushUi();

    expect(mockCompaniesApi.emergencyPause).toHaveBeenCalledWith("company-1");
    expect(mockWebauthnApi.getAuthenticationOptions).not.toHaveBeenCalled();
    expect(mockCompaniesApi.emergencyResume).not.toHaveBeenCalled();
  });

  // ── Scenario 3: Emergency Resume triggers WebAuthn authentication with purpose: 'emergency_resume' ──
  it("Scenario 3: Emergency Resume triggers WebAuthn authentication with purpose: 'emergency_resume' when paused", async () => {
    mockCurrentCompany = {
      id: "company-1",
      name: "Acme Corp",
      status: "paused",
    };

    const mockOptions = { challenge: "challenge-xyz-123", rpId: "localhost" };
    const mockAuthResponse = {
      id: "cred-xyz",
      rawId: "raw-xyz",
      response: { clientDataJSON: "abc", authenticatorData: "def", signature: "ghi" },
      type: "public-key",
    };

    mockWebauthnApi.getAuthenticationOptions.mockResolvedValue(mockOptions);
    mockSimpleWebauthn.startAuthentication.mockResolvedValue(mockAuthResponse);
    mockWebauthnApi.verifyAuthentication.mockResolvedValue({
      verified: true,
      resumeToken: "res_tok_valid_456",
    });
    mockCompaniesApi.emergencyResume.mockResolvedValue({
      id: "company-1",
      status: "active",
    });

    renderComponent();
    await flushUi();

    const buttons = Array.from(container.querySelectorAll("button"));
    const resumeButton = buttons.find((b) => b.textContent?.includes("긴급 중지 해제"));
    expect(resumeButton).toBeDefined();

    await act(async () => {
      resumeButton?.click();
    });
    await flushUi();

    expect(mockWebauthnApi.getAuthenticationOptions).toHaveBeenCalledWith("company-1", {
      purpose: "emergency_resume",
    });
    expect(mockSimpleWebauthn.startAuthentication).toHaveBeenCalledWith({
      optionsJSON: mockOptions,
    });
    expect(mockWebauthnApi.verifyAuthentication).toHaveBeenCalledWith("company-1", {
      purpose: "emergency_resume",
      response: mockAuthResponse,
    });
  });

  // ── Scenario 4: WebAuthn success calls companiesApi.emergencyResume with resumeToken ──
  it("Scenario 4: WebAuthn success calls companiesApi.emergencyResume with resumeToken", async () => {
    mockCurrentCompany = {
      id: "company-1",
      name: "Acme Corp",
      status: "paused",
    };

    mockWebauthnApi.getAuthenticationOptions.mockResolvedValue({ challenge: "test-chal" });
    mockSimpleWebauthn.startAuthentication.mockResolvedValue({ id: "cred-1" });
    mockWebauthnApi.verifyAuthentication.mockResolvedValue({
      verified: true,
      resumeToken: "res_tok_verified_789",
    });
    mockCompaniesApi.emergencyResume.mockResolvedValue({
      id: "company-1",
      status: "active",
    });

    renderComponent();
    await flushUi();

    const buttons = Array.from(container.querySelectorAll("button"));
    const resumeButton = buttons.find((b) => b.textContent?.includes("긴급 중지 해제"));

    await act(async () => {
      resumeButton?.click();
    });
    await flushUi();

    expect(mockCompaniesApi.emergencyResume).toHaveBeenCalledWith("company-1", {
      resumeToken: "res_tok_verified_789",
    });
  });

  // ── Scenario 5: Zero fallback to approvalToken ────────────────────────────────
  it("Scenario 5: Zero fallback to approvalToken when verify response lacks resumeToken", async () => {
    mockCurrentCompany = {
      id: "company-1",
      name: "Acme Corp",
      status: "paused",
    };

    mockWebauthnApi.getAuthenticationOptions.mockResolvedValue({ challenge: "test-chal" });
    mockSimpleWebauthn.startAuthentication.mockResolvedValue({ id: "cred-1" });
    // Intentionally return approvalToken instead of resumeToken
    mockWebauthnApi.verifyAuthentication.mockResolvedValue({
      verified: true,
      approvalToken: "app_tok_should_not_be_used",
    });

    renderComponent();
    await flushUi();

    const buttons = Array.from(container.querySelectorAll("button"));
    const resumeButton = buttons.find((b) => b.textContent?.includes("긴급 중지 해제"));

    await act(async () => {
      resumeButton?.click();
    });
    await flushUi();

    // Must NOT call emergencyResume
    expect(mockCompaniesApi.emergencyResume).not.toHaveBeenCalled();
    // Must display error message
    expect(container.textContent).toContain("생체 인증 검증에 실패했습니다.");
  });

  // ── Scenario 6: Handles WebAuthn cancellation/error gracefully ─────────────────
  it("Scenario 6a: Gracefully handles biometric cancellation (NotAllowedError)", async () => {
    mockCurrentCompany = {
      id: "company-1",
      name: "Acme Corp",
      status: "paused",
    };

    mockWebauthnApi.getAuthenticationOptions.mockResolvedValue({ challenge: "test-chal" });
    mockSimpleWebauthn.startAuthentication.mockRejectedValue(
      new DOMException("The operation either timed out or was not allowed", "NotAllowedError"),
    );

    renderComponent();
    await flushUi();

    const buttons = Array.from(container.querySelectorAll("button"));
    const resumeButton = buttons.find((b) => b.textContent?.includes("긴급 중지 해제"));

    await act(async () => {
      resumeButton?.click();
    });
    await flushUi();

    expect(mockCompaniesApi.emergencyResume).not.toHaveBeenCalled();
    expect(container.textContent).toContain("생체 인증이 취소되었습니다.");
  });

  // ── Scenario 7: Expired approvals never surface in the pending tab ─────────────
  it("Scenario 7a: fetches pending/revision_requested via the server's effectiveStatus filter, not the unfiltered list, for the pending tab", async () => {
    mockCurrentCompany = { id: "company-1", name: "Acme Corp", status: "active" };
    mockApprovalsApi.list.mockResolvedValue([]);

    renderComponent();
    await flushUi();

    expect(mockApprovalsApi.list).toHaveBeenCalledWith("company-1", "pending");
    expect(mockApprovalsApi.list).toHaveBeenCalledWith("company-1", "revision_requested");
  });

  it("Scenario 7b: an approval whose raw status is still 'pending' but has already expired (excluded by the server's effectiveStatus filter) is never shown as pending", async () => {
    mockCurrentCompany = { id: "company-1", name: "Acme Corp", status: "active" };

    const staleExpiredApproval = {
      id: "approval-stale-expired",
      status: "pending",
      type: "request_board_approval",
      createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      payload: { title: "Long-expired approval" },
    };

    // The unfiltered call (used only for the history tab) still returns the
    // stale row — but the server's own status-filtered endpoints (what the
    // pending tab actually queries) correctly exclude it as expired.
    mockApprovalsApi.list.mockImplementation((_companyId: string, status?: string) => {
      if (status === "pending" || status === "revision_requested") return Promise.resolve([]);
      return Promise.resolve([staleExpiredApproval]);
    });

    renderComponent();
    await flushUi();

    const buttons = Array.from(container.querySelectorAll("button"));
    const pendingTabButton = buttons.find((b) => b.textContent?.includes("대기 중"));
    expect(pendingTabButton?.textContent).toContain("대기 중 (0)");
    expect(container.textContent).toContain("대기 중인 승인 요청이 없습니다.");
    expect(container.textContent).not.toContain("Long-expired approval");
  });

  it("Scenario 7c: a genuinely pending approval (server-confirmed, not expired) is shown, and its count reflects only the filtered result", async () => {
    mockCurrentCompany = { id: "company-1", name: "Acme Corp", status: "active" };

    const realPendingApproval = {
      id: "approval-real-pending",
      status: "pending",
      type: "request_board_approval",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      payload: { title: "Genuinely pending approval" },
    };
    const staleExpiredApproval = {
      id: "approval-stale-expired",
      status: "pending",
      type: "request_board_approval",
      createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      payload: { title: "Long-expired approval" },
    };

    mockApprovalsApi.list.mockImplementation((_companyId: string, status?: string) => {
      if (status === "pending") return Promise.resolve([realPendingApproval]);
      if (status === "revision_requested") return Promise.resolve([]);
      // Unfiltered (history tab) sees both raw-status "pending" rows.
      return Promise.resolve([realPendingApproval, staleExpiredApproval]);
    });

    renderComponent();
    await flushUi();

    const buttons = Array.from(container.querySelectorAll("button"));
    const pendingTabButton = buttons.find((b) => b.textContent?.includes("대기 중"));
    expect(pendingTabButton?.textContent).toContain("대기 중 (1)");
    expect(container.textContent).toContain("Genuinely pending approval");
    expect(container.textContent).not.toContain("Long-expired approval");
  });

  it("Scenario 6b: Gracefully handles unsupported WebAuthn environment", async () => {
    mockCurrentCompany = {
      id: "company-1",
      name: "Acme Corp",
      status: "paused",
    };

    mockSimpleWebauthn.browserSupportsWebAuthn.mockReturnValue(false);

    renderComponent();
    await flushUi();

    const buttons = Array.from(container.querySelectorAll("button"));
    const resumeButton = buttons.find((b) => b.textContent?.includes("긴급 중지 해제"));

    await act(async () => {
      resumeButton?.click();
    });
    await flushUi();

    expect(mockWebauthnApi.getAuthenticationOptions).not.toHaveBeenCalled();
    expect(mockCompaniesApi.emergencyResume).not.toHaveBeenCalled();
    expect(container.textContent).toContain("이 브라우저 또는 기기는 WebAuthn 생체 인증을 지원하지 않습니다.");
  });

  // ── Scenario 8: Upper control navigation links (Summary & Settings) ───────────
  it("Scenario 8a: Renders both summary and settings navigation links in the upper control area", async () => {
    mockCurrentCompany = {
      id: "company-1",
      name: "Acme Corp",
      status: "active",
    };

    renderComponent();
    await flushUi();

    const summaryLink = container.querySelector('[data-testid="mobile-console-summary-link"]');
    const settingsLink = container.querySelector('[data-testid="mobile-console-settings-link"]');

    expect(summaryLink).not.toBeNull();
    expect(settingsLink).not.toBeNull();
  });

  it("Scenario 8b: Verifies exact destinations and labels for both links", async () => {
    mockCurrentCompany = {
      id: "company-1",
      name: "Acme Corp",
      status: "active",
    };

    renderComponent();
    await flushUi();

    const summaryLink = container.querySelector<HTMLAnchorElement>(
      '[data-testid="mobile-console-summary-link"]',
    );
    const settingsLink = container.querySelector<HTMLAnchorElement>(
      '[data-testid="mobile-console-settings-link"]',
    );

    expect(summaryLink).not.toBeNull();
    expect(summaryLink?.getAttribute("href")).toBe("/ai-office?view=summary");
    expect(summaryLink?.textContent?.trim()).toBe("경영진 요약");

    expect(settingsLink).not.toBeNull();
    expect(settingsLink?.getAttribute("href")).toBe("/mobile/settings");
    expect(settingsLink?.textContent?.trim()).toBe("기기·보안 설정");
  });

  it("Scenario 8c: Verifies min-h-9 touch targets on both links", async () => {
    mockCurrentCompany = {
      id: "company-1",
      name: "Acme Corp",
      status: "active",
    };

    renderComponent();
    await flushUi();

    const summaryLink = container.querySelector(
      '[data-testid="mobile-console-summary-link"]',
    );
    const settingsLink = container.querySelector(
      '[data-testid="mobile-console-settings-link"]',
    );

    expect(summaryLink).not.toBeNull();
    expect(settingsLink).not.toBeNull();
    expect(summaryLink?.classList.contains("min-h-9")).toBe(true);
    expect(settingsLink?.classList.contains("min-h-9")).toBe(true);
  });
});
