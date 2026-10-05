import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const uiRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

type FetchListener = (event: {
  request: { method: string; url: string; mode: string };
  respondWith: (response: Promise<Response | undefined> | Response) => void;
}) => void;

function loadServiceWorkerFetchListener(overrides: {
  fetch: () => Promise<Response>;
  cachesMatch: (key: unknown) => Promise<Response | undefined>;
}): FetchListener {
  const listeners = new Map<string, (event: unknown) => void>();
  const swSelf = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener);
    },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
    location: { origin: "https://app.example.com" },
  };
  const caches = {
    match: overrides.cachesMatch,
    open: vi.fn(async () => ({ put: vi.fn() })),
    keys: vi.fn(async () => []),
    delete: vi.fn(async () => true),
  };
  const code = readFileSync(resolve(uiRoot, "public/sw.js"), "utf8");
  new Function("self", "caches", "fetch", "Response", "URL", code)(
    swSelf,
    caches,
    overrides.fetch,
    Response,
    URL,
  );
  const listener = listeners.get("fetch");
  if (!listener) throw new Error("sw.js registered no fetch listener");
  return listener as FetchListener;
}

async function respondTo(
  listener: FetchListener,
  request: { method: string; url: string; mode: string },
): Promise<Response | undefined> {
  let captured: Promise<Response | undefined> | Response | undefined;
  listener({
    request,
    respondWith: (response) => {
      captured = response;
    },
  });
  return await captured;
}

describe("sw.js offline fallback", () => {
  it("serves the Offline response for a failed navigation with an empty cache", async () => {
    const listener = loadServiceWorkerFetchListener({
      fetch: () => Promise.reject(new TypeError("network down")),
      cachesMatch: async () => undefined,
    });

    const response = await respondTo(listener, {
      method: "GET",
      url: "https://app.example.com/settings/instance",
      mode: "navigate",
    });

    // respondWith must always receive a real Response; resolving undefined
    // fails the navigation with "Failed to convert value to 'Response'".
    expect(response).toBeInstanceOf(Response);
    expect(response!.status).toBe(503);
    expect(await response!.text()).toBe("Offline");
  });

  it("serves the cached shell for a failed navigation when one exists", async () => {
    const shell = new Response("<html>app shell</html>", { status: 200 });
    const listener = loadServiceWorkerFetchListener({
      fetch: () => Promise.reject(new TypeError("network down")),
      cachesMatch: async (key) => (key === "/" ? shell : undefined),
    });

    const response = await respondTo(listener, {
      method: "GET",
      url: "https://app.example.com/settings/instance",
      mode: "navigate",
    });

    expect(response).toBe(shell);
  });

  it("returns a network-error Response for a failed asset with no cache entry", async () => {
    const listener = loadServiceWorkerFetchListener({
      fetch: () => Promise.reject(new TypeError("network down")),
      cachesMatch: async () => undefined,
    });

    const response = await respondTo(listener, {
      method: "GET",
      url: "https://app.example.com/assets/index-abc.js",
      mode: "no-cors",
    });

    expect(response).toBeInstanceOf(Response);
    expect(response!.type).toBe("error");
  });
});

describe("sw.js push notification and deep linking", () => {
  function loadServiceWorkerPushListeners() {
    const listeners = new Map<string, (event: any) => void>();
    const showNotification = vi.fn();
    const openWindow = vi.fn();
    const matchAll = vi.fn();

    const swSelf = {
      addEventListener: (type: string, listener: (event: any) => void) => {
        listeners.set(type, listener);
      },
      skipWaiting: vi.fn(),
      clients: {
        claim: vi.fn(),
        matchAll,
        openWindow,
      },
      registration: {
        showNotification,
      },
      location: { origin: "https://app.example.com" },
    };

    const caches = {
      match: vi.fn(),
      open: vi.fn(async () => ({ put: vi.fn() })),
      keys: vi.fn(async () => []),
      delete: vi.fn(async () => true),
    };

    const code = readFileSync(resolve(uiRoot, "public/sw.js"), "utf8");
    new Function("self", "caches", "fetch", "Response", "URL", code)(
      swSelf,
      caches,
      vi.fn(),
      Response,
      URL,
    );

    return {
      pushListener: listeners.get("push")!,
      clickListener: listeners.get("notificationclick")!,
      showNotification,
      openWindow,
      matchAll,
    };
  }

  it("handles push event and shows notification with approval deep-link", async () => {
    const { pushListener, showNotification } = loadServiceWorkerPushListeners();
    expect(pushListener).toBeDefined();

    let waitUntilPromise: Promise<void> | null = null;
    const event = {
      data: {
        json: () => ({
          title: "긴급 승인 요청",
          body: "서대곤 대표님의 Face ID 결재가 필요합니다.",
          url: "/mobile/approvals/app-123",
          tag: "approval-app-123",
        }),
        text: () => "fallback text",
      },
      waitUntil: (p: Promise<void>) => {
        waitUntilPromise = p;
      },
    };

    pushListener(event);
    await waitUntilPromise;

    expect(showNotification).toHaveBeenCalledWith(
      "긴급 승인 요청",
      expect.objectContaining({
        body: "서대곤 대표님의 Face ID 결재가 필요합니다.",
        tag: "approval-app-123",
        data: expect.objectContaining({
          url: "/mobile/approvals/app-123",
        }),
      }),
    );
  });

  it("handles notificationclick by navigating existing focused window client", async () => {
    const { clickListener, matchAll } = loadServiceWorkerPushListeners();
    expect(clickListener).toBeDefined();

    const mockClient = {
      url: "https://app.example.com/mobile/approvals",
      navigate: vi.fn().mockResolvedValue(undefined),
      focus: vi.fn().mockResolvedValue(undefined),
    };
    matchAll.mockResolvedValue([mockClient]);

    let waitUntilPromise: Promise<void> | null = null;
    const closeNotification = vi.fn();
    const event = {
      notification: {
        close: closeNotification,
        data: { url: "/mobile/approvals/app-123" },
      },
      waitUntil: (p: Promise<void>) => {
        waitUntilPromise = p;
      },
    };

    clickListener(event);
    await waitUntilPromise;

    expect(closeNotification).toHaveBeenCalled();
    expect(mockClient.navigate).toHaveBeenCalledWith("/mobile/approvals/app-123");
    expect(mockClient.focus).toHaveBeenCalled();
  });

  it("handles notificationclick by opening a new window when no client exists", async () => {
    const { clickListener, matchAll, openWindow } = loadServiceWorkerPushListeners();
    matchAll.mockResolvedValue([]);
    openWindow.mockResolvedValue(undefined);

    let waitUntilPromise: Promise<void> | null = null;
    const closeNotification = vi.fn();
    const event = {
      notification: {
        close: closeNotification,
        data: { url: "/mobile/approvals/app-456" },
      },
      waitUntil: (p: Promise<void>) => {
        waitUntilPromise = p;
      },
    };

    clickListener(event);
    await waitUntilPromise;

    expect(closeNotification).toHaveBeenCalled();
    expect(openWindow).toHaveBeenCalledWith("/mobile/approvals/app-456");
  });
});

