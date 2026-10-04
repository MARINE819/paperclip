// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AIOfficeSecretsLab } from "./AIOfficeSecretsLab";
import type { SecretsRegistryEntry } from "../api/secrets";

const mockRegistry = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
vi.mock("@/api/secrets", () => ({ secretsRegistryApi: mockRegistry }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SECRET_MARKER = "sk-plaintext-must-never-render-123";
const entries: SecretsRegistryEntry[] = [
  {
    id: "secret-1", type: "secret", provider: "local_encrypted", ownerType: "company",
    ownerId: "company-1", scope: "company", status: "active", maskedIdentifier: null,
    label: "OpenAI API Key", createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z", lastUsedAt: null, expiresAt: null,
    revokedAt: null, createdBy: "admin-1",
  },
  {
    id: "agent-key-1", type: "agent_api_key", provider: "paperclip", ownerType: "agent",
    ownerId: "agent-1", scope: "agent", status: "revoked",
    maskedIdentifier: "hash:a1b2c3…9f8e", label: "CI agent key",
    createdAt: "2026-09-03T00:00:00.000Z", updatedAt: null,
    lastUsedAt: null, expiresAt: null, revokedAt: "2026-09-04T00:00:00.000Z", createdBy: null,
  },
  {
    id: "board-key-1", type: "board_api_key", provider: "paperclip", ownerType: "user",
    ownerId: "board-1", scope: "approval_only", status: "expired",
    maskedIdentifier: "hash:f4e3d2…7b6a", label: null,
    createdAt: "2026-09-05T00:00:00.000Z", updatedAt: null,
    lastUsedAt: null, expiresAt: "2026-09-06T00:00:00.000Z", revokedAt: null, createdBy: null,
  },
];

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 10));
}

describe("AIOfficeSecretsLab", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    mockRegistry.list.mockResolvedValue({ entries });
    mockRegistry.get.mockImplementation(async (_companyId: string, id: string) => ({
      entry: { ...entries.find((entry) => entry.id === id), material: SECRET_MARKER },
    }));
    render = async () => {
      flushSync(() => root.render(
        <QueryClientProvider client={queryClient}>
          <AIOfficeSecretsLab companyId="company-1" />
        </QueryClientProvider>,
      ));
      await act(async () => {
        await settle();
      });
    };
  });

  let render: () => Promise<void>;

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    document.body.style.pointerEvents = "";
    vi.clearAllMocks();
  });

  it("renders company-scoped safe metadata, counts, masked identifiers, and null fallbacks", async () => {
    await render();
    expect(mockRegistry.list).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("Control Center — Secrets & Credentials (F-02)");
    expect(container.textContent).toContain("OpenAI API Key");
    expect(container.textContent).toContain("CI agent key");
    expect(container.textContent).toContain("이름 없음");
    expect(container.textContent).toContain("hash:a1b2c3…9f8e");
    expect(container.textContent).toContain("hash:f4e3d2…7b6a");
    expect(container.textContent).toContain("값 미표시");
    expect(container.textContent).toContain("revoked");
    expect(container.textContent).toContain("expired");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(container.querySelector("[aria-label='Secrets summary']")?.textContent).toContain("전체 기록3");
    expect(document.body.textContent).not.toContain(SECRET_MARKER);
  });

  it("gets a company-scoped detail and renders only explicit safe projection fields", async () => {
    await render();
    const button = container.querySelector("tbody tr button") as HTMLButtonElement;
    flushSync(() => button.click());
    await settle();
    await settle();
    expect(mockRegistry.get).toHaveBeenCalledWith("company-1", "secret-1");
    const dialog = document.body.querySelector("[role='dialog']") as HTMLElement;
    expect(dialog.textContent).toContain("OpenAI API Key — 안전한 상세 정보");
    expect(dialog.textContent).toContain("admin-1");
    expect(dialog.textContent).toContain("company-1");
    expect(dialog.textContent).toContain("값 미표시");
    expect(dialog.textContent).not.toContain(SECRET_MARKER);
    expect(dialog.textContent).not.toMatch(/복사|표시하기|reveal|rotate|revoke|delete/i);
    const close = Array.from(dialog.querySelectorAll("button")).find((item) => item.textContent?.trim() === "닫기");
    flushSync(() => close?.click());
    await settle();
    expect(document.body.querySelector("[role='dialog']")).toBeNull();
  });

  it("filters only on safe fields and shows a filtered empty state", async () => {
    await render();
    const agentFilter = Array.from(container.querySelectorAll("button")).find(
      (item) => item.textContent?.trim() === "에이전트 API 키",
    );
    flushSync(() => agentFilter?.click());
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(container.textContent).toContain("CI agent key");
    const input = container.querySelector("input") as HTMLInputElement;
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "no match");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    expect(container.textContent).toContain("검색 조건에 맞는 기록이 없습니다.");
  });

  it("shows an empty state when the safe registry returns no entries", async () => {
    mockRegistry.list.mockResolvedValue({ entries: [] });
    await render();
    expect(container.textContent).toContain("표시할 비밀 또는 자격 증명 기록이 없습니다.");
  });

  it("shows a list API error without rendering stale inventory", async () => {
    mockRegistry.list.mockRejectedValue(new Error("service unavailable"));
    await render();
    expect(container.querySelector("[role='alert']")?.textContent).toContain("Secrets Registry 데이터를 불러올 수 없습니다.");
    expect(container.querySelector("tbody")).toBeNull();
  });
});
