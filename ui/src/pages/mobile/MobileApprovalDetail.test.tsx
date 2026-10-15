// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileApprovalDetail } from "./MobileApprovalDetail";

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
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("MobileApprovalDetail WebAuthn wiring and token gate", () => {
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
          <MobileApprovalDetail />
        </QueryClientProvider>,
      );
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

    renderComponent();
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

    renderComponent();
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

    renderComponent();
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

    renderComponent();
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

    renderComponent();
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
    act(() => {
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
    renderComponent();
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
});
