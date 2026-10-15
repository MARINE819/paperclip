// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileApprovalDetail, UI_TOKEN_TTL_MS } from "./MobileApprovalDetail";

const mockNavigate = vi.fn();
const mockApprovalsApi = vi.hoisted(() => ({
  get: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
}));

const mockWebauthnApi = vi.hoisted(() => ({
  getAuthenticationOptions: vi.fn(),
  verifyAuthentication: vi.fn(),
}));

const mockSimpleWebauthn = vi.hoisted(() => ({
  startAuthentication: vi.fn(),
  browserSupportsWebAuthn: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  useParams: () => ({ approvalId: "app-1" }),
  useNavigate: () => mockNavigate,
}));

vi.mock("../../api/approvals", () => ({
  approvalsApi: mockApprovalsApi,
}));

vi.mock("../../api/webauthn", () => ({
  webauthnApi: mockWebauthnApi,
}));

vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: mockSimpleWebauthn.startAuthentication,
  browserSupportsWebAuthn: mockSimpleWebauthn.browserSupportsWebAuthn,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushUi() {
  await act(async () => {
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
    if (vi.isFakeTimers()) {
      vi.advanceTimersByTime(0);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
  });
}

describe("MobileApprovalDetail WebAuthn wiring and token gate", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;
  let isUnmounted = false;

  beforeEach(() => {
    isUnmounted = false;
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });

    mockApprovalsApi.get.mockResolvedValue({
      id: "app-1",
      companyId: "company-1",
      type: "command_execution",
      status: "pending",
      payload: {
        risks: ["HIGH RISK: Dangerous operation"],
        proposedCommands: ["sudo rm -rf /tmp/cache"],
      },
      createdAt: new Date().toISOString(),
    });

    mockSimpleWebauthn.browserSupportsWebAuthn.mockReturnValue(true);
  });

  afterEach(async () => {
    if (vi.isFakeTimers()) {
      vi.useRealTimers();
    }
    if (!isUnmounted) {
      await act(async () => {
        root.unmount();
      });
    }
    queryClient.clear();
    container.remove();
  });

  async function renderComponent() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MobileApprovalDetail />
        </QueryClientProvider>,
      );
    });
    await flushUi();
    await act(async () => {
      await vi.waitFor(() => expect(container.textContent).toContain("HIGH RISK WARNING"));
    });
  }

  it("successful WebAuthn verification passes approvalToken to approvalsApi.approve", async () => {
    mockWebauthnApi.getAuthenticationOptions.mockResolvedValue({
      challenge: "server-challenge-123",
      rpId: "localhost",
    });
    mockSimpleWebauthn.startAuthentication.mockResolvedValue({
      id: "cred-1",
      rawId: "raw-1",
      response: { clientDataJSON: "abc", authenticatorData: "def", signature: "ghi" },
      type: "public-key",
    });
    mockWebauthnApi.verifyAuthentication.mockResolvedValue({
      verified: true,
      credentialId: "cred-1",
      approvalToken: "tok_mobile_sec_999",
    });
    mockApprovalsApi.approve.mockResolvedValue({
      id: "app-1",
      status: "approved",
    });

    await renderComponent();
    await vi.waitFor(() => expect(container.textContent).toContain("HIGH RISK WARNING"));

    // Click Face ID authentication button
    const authButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Face ID"),
    );
    expect(authButton).toBeDefined();

    await act(async () => {
      authButton!.click();
    });
    await flushUi();

    // Expect WebAuthn options and startAuthentication called
    expect(mockWebauthnApi.getAuthenticationOptions).toHaveBeenCalledWith("company-1", {
      purpose: "approval_decision",
      bindingId: "app-1",
    });
    expect(mockSimpleWebauthn.startAuthentication).toHaveBeenCalledWith({
      optionsJSON: expect.anything(),
    });
    expect(mockWebauthnApi.verifyAuthentication).toHaveBeenCalledWith("company-1", {
      purpose: "approval_decision",
      bindingId: "app-1",
      response: expect.anything(),
    });

    // Expect authentication success badge displayed
    expect(container.textContent).toContain("생체인증 완료");

    // Click Approve button
    const approveButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("승인 실행"),
    );
    expect(approveButton).toBeDefined();

    await act(async () => {
      approveButton!.click();
    });
    await flushUi();

    // Verify approval token was passed to approve mutation
    expect(mockApprovalsApi.approve).toHaveBeenCalledWith("app-1", undefined, {
      approvalToken: "tok_mobile_sec_999",
    });
    expect(mockNavigate).toHaveBeenCalledWith("/mobile/approvals", { replace: true });
  });

  it("cancelled WebAuthn (NotAllowedError) displays cancellation message and NEVER calls approvalsApi.approve", async () => {
    mockWebauthnApi.getAuthenticationOptions.mockResolvedValue({ challenge: "chal-1" });
    const notAllowedError = new Error("User canceled authentication");
    notAllowedError.name = "NotAllowedError";
    mockSimpleWebauthn.startAuthentication.mockRejectedValue(notAllowedError);

    await renderComponent();
    await vi.waitFor(() => expect(container.textContent).toContain("HIGH RISK WARNING"));

    const authButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Face ID"),
    );
    expect(authButton).toBeDefined();

    await act(async () => {
      authButton!.click();
    });
    await flushUi();

    // Cancellation message shown
    expect(container.textContent).toContain("생체 인증이 취소되었습니다.");

    // approve API must NEVER be called (fail-closed)
    expect(mockApprovalsApi.approve).not.toHaveBeenCalled();

    // Approve button remains disabled
    const approveButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("승인 실행"),
    );
    expect(approveButton?.hasAttribute("disabled")).toBe(true);
  });

  it("failed WebAuthn verification (verified: false) NEVER calls approvalsApi.approve", async () => {
    mockWebauthnApi.getAuthenticationOptions.mockResolvedValue({ challenge: "chal-2" });
    mockSimpleWebauthn.startAuthentication.mockResolvedValue({ id: "cred-bad", response: {} });
    mockWebauthnApi.verifyAuthentication.mockResolvedValue({ verified: false });

    await renderComponent();
    await vi.waitFor(() => expect(container.textContent).toContain("HIGH RISK WARNING"));

    const authButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Face ID"),
    );

    await act(async () => {
      authButton!.click();
    });
    await flushUi();

    expect(container.textContent).toContain("생체 인증 검증에 실패했습니다.");
    expect(mockApprovalsApi.approve).not.toHaveBeenCalled();
  });

  it("unsupported browser shows error and NEVER calls approvalsApi.approve", async () => {
    mockSimpleWebauthn.browserSupportsWebAuthn.mockReturnValue(false);

    await renderComponent();
    await vi.waitFor(() => expect(container.textContent).toContain("HIGH RISK WARNING"));

    const authButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Face ID"),
    );

    await act(async () => {
      authButton!.click();
    });
    await flushUi();

    expect(container.textContent).toContain("WebAuthn 생체 인증을 지원하지 않습니다");
    expect(mockWebauthnApi.getAuthenticationOptions).not.toHaveBeenCalled();
    expect(mockApprovalsApi.approve).not.toHaveBeenCalled();
  });

  it("decision note is passed through along with approvalToken", async () => {
    mockWebauthnApi.getAuthenticationOptions.mockResolvedValue({ challenge: "chal-note" });
    mockSimpleWebauthn.startAuthentication.mockResolvedValue({ id: "cred-1", response: {} });
    mockWebauthnApi.verifyAuthentication.mockResolvedValue({
      verified: true,
      approvalToken: "token-with-note-123",
    });
    mockApprovalsApi.approve.mockResolvedValue({ id: "app-1", status: "approved" });

    await renderComponent();
    await vi.waitFor(() => expect(container.textContent).toContain("HIGH RISK WARNING"));

    // Authenticate first
    const authButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Face ID"),
    );
    await act(async () => {
      authButton!.click();
    });
    await flushUi();

    // Enter decision note
    const textarea = container.querySelector("textarea")!;
    expect(textarea).toBeDefined();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "대표자 직접 승인 완료");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushUi();

    // Click Approve
    const approveButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("승인 실행"),
    );
    await act(async () => {
      approveButton!.click();
    });
    await flushUi();

    expect(mockApprovalsApi.approve).toHaveBeenCalledWith("app-1", "대표자 직접 승인 완료", {
      approvalToken: "token-with-note-123",
    });
  });

  it("renders approval actions container with sticky positioning above bottom navigation", async () => {
    await renderComponent();
    await vi.waitFor(() => expect(container.textContent).toContain("HIGH RISK WARNING"));

    const actionsContainer = container.querySelector(
      '[data-testid="mobile-approval-actions"]',
    );
    expect(actionsContainer).not.toBeNull();
    const className = actionsContainer?.getAttribute("class") ?? "";

    expect(className).toContain("sticky");
    expect(className).toContain("bottom-(--tc-composer-bottom)");
    expect(className).toContain("z-20");
    expect(className).toContain("transition-[bottom]");
    expect(className).not.toContain("fixed");
    expect(className).not.toContain("bottom-0");
  });

  it("automatic reset after 60 seconds", async () => {
    expect(UI_TOKEN_TTL_MS).toBe(60_000);

    mockWebauthnApi.getAuthenticationOptions.mockResolvedValue({
      challenge: "server-challenge-123",
      rpId: "localhost",
    });
    mockSimpleWebauthn.startAuthentication.mockResolvedValue({
      id: "cred-1",
      rawId: "raw-1",
      response: { clientDataJSON: "abc", authenticatorData: "def", signature: "ghi" },
      type: "public-key",
    });
    mockWebauthnApi.verifyAuthentication.mockResolvedValue({
      verified: true,
      credentialId: "cred-1",
      approvalToken: "tok_mobile_sec_999",
    });

    await renderComponent();
    await vi.waitFor(() => expect(container.textContent).toContain("HIGH RISK WARNING"));

    vi.useFakeTimers();

    const authButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Face ID"),
    );
    expect(authButton).toBeDefined();

    await act(async () => {
      authButton!.click();
    });
    await flushUi();

    expect(container.textContent).toContain("생체인증 완료");
    expect(container.textContent).toContain("60초");

    // Advance timers by 60 seconds (TTL expiration)
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await flushUi();

    // Verify reset state: error message displayed and authenticated badge removed
    expect(container.textContent).toContain(
      "인증 시간이 만료되었습니다. Face ID로 다시 인증해 주세요.",
    );
    expect(container.textContent).not.toContain("생체인증 완료");

    // Face ID button restored
    const restoredAuthButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Face ID"),
    );
    expect(restoredAuthButton).toBeDefined();

    // Approve button should be disabled
    const approveButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("승인 실행"),
    );
    expect(approveButton?.hasAttribute("disabled")).toBe(true);

    // Clicking approve does not call API
    await act(async () => {
      approveButton!.click();
    });
    expect(mockApprovalsApi.approve).not.toHaveBeenCalled();
  });

  it("HTTP 410 reset", async () => {
    mockWebauthnApi.getAuthenticationOptions.mockResolvedValue({
      challenge: "server-challenge-123",
      rpId: "localhost",
    });
    mockSimpleWebauthn.startAuthentication.mockResolvedValue({
      id: "cred-1",
      rawId: "raw-1",
      response: { clientDataJSON: "abc", authenticatorData: "def", signature: "ghi" },
      type: "public-key",
    });
    mockWebauthnApi.verifyAuthentication.mockResolvedValue({
      verified: true,
      credentialId: "cred-1",
      approvalToken: "tok_mobile_sec_999",
    });

    const http410Error = Object.assign(new Error("Approval token expired"), {
      status: 410,
      body: { reason: "approval_token_expired" },
    });
    mockApprovalsApi.approve.mockRejectedValue(http410Error);

    await renderComponent();
    await vi.waitFor(() => expect(container.textContent).toContain("HIGH RISK WARNING"));

    // Authenticate
    const authButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Face ID"),
    );
    expect(authButton).toBeDefined();

    await act(async () => {
      authButton!.click();
    });
    await flushUi();

    expect(container.textContent).toContain("생체인증 완료");

    // Click Approve
    const approveButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("승인 실행"),
    );
    expect(approveButton).toBeDefined();

    await act(async () => {
      approveButton!.click();
    });
    await flushUi();

    // Verify HTTP 410 reset
    expect(container.textContent).toContain(
      "인증 시간이 만료되었습니다. Face ID로 다시 인증해 주세요.",
    );
    expect(container.textContent).not.toContain("생체인증 완료");

    // Face ID button restored
    const restoredAuthButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Face ID"),
    );
    expect(restoredAuthButton).toBeDefined();

    // Approve button disabled
    const currentApproveButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("승인 실행"),
    );
    expect(currentApproveButton?.hasAttribute("disabled")).toBe(true);
  });

  it("45 seconds remaining after 15 seconds", async () => {
    mockWebauthnApi.getAuthenticationOptions.mockResolvedValue({
      challenge: "server-challenge-123",
      rpId: "localhost",
    });
    mockSimpleWebauthn.startAuthentication.mockResolvedValue({
      id: "cred-1",
      rawId: "raw-1",
      response: { clientDataJSON: "abc", authenticatorData: "def", signature: "ghi" },
      type: "public-key",
    });
    mockWebauthnApi.verifyAuthentication.mockResolvedValue({
      verified: true,
      credentialId: "cred-1",
      approvalToken: "tok_mobile_sec_999",
    });

    await renderComponent();
    await vi.waitFor(() => expect(container.textContent).toContain("HIGH RISK WARNING"));

    vi.useFakeTimers();

    const authButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Face ID"),
    );
    expect(authButton).toBeDefined();

    await act(async () => {
      authButton!.click();
    });
    await flushUi();

    expect(container.textContent).toContain("생체인증 완료");
    expect(container.textContent).toContain("60초");

    // Advance 15 seconds
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    await flushUi();

    // Verify 45 seconds remaining
    expect(container.textContent).toContain("45초");
    expect(container.textContent).toContain("생체인증 완료");
  });

  it("timer cleanup on unmount", async () => {
    mockWebauthnApi.getAuthenticationOptions.mockResolvedValue({
      challenge: "server-challenge-123",
      rpId: "localhost",
    });
    mockSimpleWebauthn.startAuthentication.mockResolvedValue({
      id: "cred-1",
      rawId: "raw-1",
      response: { clientDataJSON: "abc", authenticatorData: "def", signature: "ghi" },
      type: "public-key",
    });
    mockWebauthnApi.verifyAuthentication.mockResolvedValue({
      verified: true,
      credentialId: "cred-1",
      approvalToken: "tok_mobile_sec_999",
    });

    await renderComponent();
    await vi.waitFor(() => expect(container.textContent).toContain("HIGH RISK WARNING"));

    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    const authButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Face ID"),
    );
    expect(authButton).toBeDefined();

    await act(async () => {
      authButton!.click();
    });
    await flushUi();

    expect(container.textContent).toContain("생체인증 완료");

    await act(async () => {
      root.unmount();
    });
    isUnmounted = true;

    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
    vi.useRealTimers();
  });

  it("does not reset authentication when 410 reason is approval_expired or 400 with approval_token_expired", async () => {
    mockWebauthnApi.getAuthenticationOptions.mockResolvedValue({
      challenge: "server-challenge-123",
      rpId: "localhost",
    });
    mockSimpleWebauthn.startAuthentication.mockResolvedValue({
      id: "cred-1",
      rawId: "raw-1",
      response: { clientDataJSON: "abc", authenticatorData: "def", signature: "ghi" },
      type: "public-key",
    });
    mockWebauthnApi.verifyAuthentication.mockResolvedValue({
      verified: true,
      credentialId: "cred-1",
      approvalToken: "tok_mobile_sec_999",
    });

    await renderComponent();
    await vi.waitFor(() => expect(container.textContent).toContain("HIGH RISK WARNING"));

    const authButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Face ID"),
    );
    expect(authButton).toBeDefined();

    await act(async () => {
      authButton!.click();
    });
    await flushUi();

    expect(container.textContent).toContain("생체인증 완료");

    const approveButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("승인 실행"),
    );
    expect(approveButton).toBeDefined();

    // 1. 410 with reason 'approval_expired' (not approval_token_expired)
    const error410WrongReason = Object.assign(new Error("Approval expired"), {
      status: 410,
      body: { reason: "approval_expired" },
    });
    mockApprovalsApi.approve.mockRejectedValueOnce(error410WrongReason);

    await act(async () => {
      approveButton!.click();
    });
    await flushUi();

    expect(container.textContent).toContain("생체인증 완료");
    expect(container.textContent).not.toContain(
      "인증 시간이 만료되었습니다. Face ID로 다시 인증해 주세요.",
    );
    expect(container.textContent).toContain("Approval expired");
    expect(approveButton?.hasAttribute("disabled")).toBe(false);

    // 2. 400 with reason 'approval_token_expired' (status is 400, not 410)
    const error400WrongStatus = Object.assign(new Error("Bad request"), {
      status: 400,
      body: { reason: "approval_token_expired" },
    });
    mockApprovalsApi.approve.mockRejectedValueOnce(error400WrongStatus);

    await act(async () => {
      approveButton!.click();
    });
    await flushUi();

    expect(container.textContent).toContain("생체인증 완료");
    expect(container.textContent).not.toContain(
      "인증 시간이 만료되었습니다. Face ID로 다시 인증해 주세요.",
    );
    expect(container.textContent).toContain("Bad request");
    expect(approveButton?.hasAttribute("disabled")).toBe(false);
  });
});
