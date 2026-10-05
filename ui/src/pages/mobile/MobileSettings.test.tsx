// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileSettings } from "./MobileSettings";

const mockBreadcrumbs = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
}));

const mockWebauthnApi = vi.hoisted(() => ({
  listCredentials: vi.fn(),
  deleteCredential: vi.fn(),
  getRegistrationOptions: vi.fn(),
  verifyRegistration: vi.fn(),
}));

const mockPushApi = vi.hoisted(() => ({
  getPublicKey: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}));

const mockSimpleWebauthn = vi.hoisted(() => ({
  startRegistration: vi.fn(),
  browserSupportsWebAuthn: vi.fn(),
}));

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => mockBreadcrumbs,
}));

vi.mock("../../api/webauthn", () => ({
  webauthnApi: mockWebauthnApi,
}));

vi.mock("../../api/push", () => ({
  pushApi: mockPushApi,
  urlBase64ToUint8Array: vi.fn(() => new Uint8Array([1, 2, 3])),
}));

vi.mock("@simplewebauthn/browser", () => ({
  startRegistration: mockSimpleWebauthn.startRegistration,
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

describe("MobileSettings WebAuthn & Web Push wiring", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;
  let mockPushManager: any;
  let mockServiceWorkerRegistration: any;

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

    mockPushManager = {
      getSubscription: vi.fn().mockResolvedValue(null),
      subscribe: vi.fn().mockResolvedValue({
        endpoint: "https://push.example.com/sub-123",
        toJSON: () => ({
          endpoint: "https://push.example.com/sub-123",
          keys: { p256dh: "p256-key", auth: "auth-secret" },
        }),
      }),
    };

    mockServiceWorkerRegistration = {
      pushManager: mockPushManager,
    };

    Object.defineProperty(navigator, "serviceWorker", {
      value: {
        ready: Promise.resolve(mockServiceWorkerRegistration),
      },
      configurable: true,
    });

    (window as any).PushManager = function () {};

    mockWebauthnApi.listCredentials.mockResolvedValue([
      {
        id: "cred-1",
        credentialId: "cid-1",
        deviceName: "서대곤 iPhone 15 Pro",
        counter: 5,
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      },
    ]);

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
          <MobileSettings />
        </QueryClientProvider>,
      );
    });
  }

  it("displays registered WebAuthn credentials and handles deletion", async () => {
    mockWebauthnApi.deleteCredential.mockResolvedValue({ deleted: true });

    renderComponent();
    await vi.waitFor(() => expect(container.textContent).toContain("서대곤 iPhone 15 Pro"));

    const deleteButton = container.querySelector("button.text-red-500") as HTMLButtonElement;
    expect(deleteButton).toBeDefined();

    await act(async () => {
      deleteButton.click();
    });
    await flushUi();

    expect(mockWebauthnApi.deleteCredential).toHaveBeenCalledWith("company-1", "cred-1");
    expect(container.textContent).toContain("생체 인증 기기가 삭제되었습니다.");
  });

  it("handles WebAuthn biometric device registration", async () => {
    mockWebauthnApi.getRegistrationOptions.mockResolvedValue({
      challenge: "reg-chal-123",
      rp: { name: "Paperclip" },
      user: { id: "user-1", name: "CEO" },
    });
    mockSimpleWebauthn.startRegistration.mockResolvedValue({
      id: "new-cred-1",
      rawId: "raw-1",
      response: { clientDataJSON: "abc", attestationObject: "def" },
      type: "public-key",
    });
    mockWebauthnApi.verifyRegistration.mockResolvedValue({
      verified: true,
      credentialId: "new-cred-1",
    });

    renderComponent();
    await vi.waitFor(() => expect(container.textContent).toContain("생체 인증 (Face ID / 지문) 등록"));

    const regButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Face ID / 지문 기기 등록"),
    );
    expect(regButton).toBeDefined();

    await act(async () => {
      regButton!.click();
    });
    await flushUi();

    expect(mockWebauthnApi.getRegistrationOptions).toHaveBeenCalledWith("company-1");
    expect(mockSimpleWebauthn.startRegistration).toHaveBeenCalledWith({
      optionsJSON: expect.anything(),
    });
    expect(mockWebauthnApi.verifyRegistration).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        response: expect.anything(),
      }),
    );
    expect(container.textContent).toContain("성공적으로 등록되었습니다");
  });

  it("enables Push notifications when toggle is checked", async () => {
    (window as any).Notification = {
      requestPermission: vi.fn().mockResolvedValue("granted"),
    };
    mockPushApi.getPublicKey.mockResolvedValue({
      publicKey: "BN8Qc20948c...",
    });
    mockPushApi.subscribe.mockResolvedValue({
      ok: true,
      subscription: { id: "sub-1" },
    });

    renderComponent();
    await vi.waitFor(() => expect(container.textContent).toContain("Web Push 알림 수신"));

    const pushCheckbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(pushCheckbox).toBeDefined();
    expect(pushCheckbox.checked).toBe(false);

    await act(async () => {
      pushCheckbox.click();
    });
    await flushUi();

    expect((window as any).Notification.requestPermission).toHaveBeenCalled();
    expect(mockPushApi.getPublicKey).toHaveBeenCalled();
    expect(mockPushManager.subscribe).toHaveBeenCalled();
    expect(mockPushApi.subscribe).toHaveBeenCalledWith("company-1", {
      endpoint: "https://push.example.com/sub-123",
      keys: { p256dh: "p256-key", auth: "auth-secret" },
    });
    expect(container.textContent).toContain("Web Push 알림 수신이 활성화되었습니다.");
  });

  it("denied notification permission does NOT subscribe and shows error", async () => {
    (window as any).Notification = {
      requestPermission: vi.fn().mockResolvedValue("denied"),
    };

    renderComponent();
    await vi.waitFor(() => expect(container.textContent).toContain("Web Push 알림 수신"));

    const pushCheckbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;

    await act(async () => {
      pushCheckbox.click();
    });
    await flushUi();

    expect((window as any).Notification.requestPermission).toHaveBeenCalled();
    expect(mockPushApi.getPublicKey).not.toHaveBeenCalled();
    expect(mockPushApi.subscribe).not.toHaveBeenCalled();
    expect(container.textContent).toContain("알림 권한이 허용되지 않았습니다");
  });

  it("disables Push notifications when toggle is unchecked", async () => {
    const mockExistingSub = {
      endpoint: "https://push.example.com/existing-sub",
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    mockPushManager.getSubscription.mockResolvedValue(mockExistingSub);
    mockPushApi.unsubscribe.mockResolvedValue({ ok: true, unsubscribed: true });

    renderComponent();
    await vi.waitFor(() => {
      const pushCheckbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(pushCheckbox?.checked).toBe(true);
    });

    const pushCheckbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;

    await act(async () => {
      pushCheckbox.click();
    });
    await flushUi();

    expect(mockExistingSub.unsubscribe).toHaveBeenCalled();
    expect(mockPushApi.unsubscribe).toHaveBeenCalledWith("company-1", {
      endpoint: "https://push.example.com/existing-sub",
    });
    expect(container.textContent).toContain("Web Push 알림 수신이 해제되었습니다.");
  });
});
