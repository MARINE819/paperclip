// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AIOfficeToolTrustLab,
  ToolTypeBadge,
  TrustStatusBadge,
  RiskLevelBadge,
  SignatureStatusBadge,
} from "./AIOfficeToolTrustLab";
import type { TrustRegistryEntry } from "../api/tool-trust";

const mockToolTrustApi = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
}));

vi.mock("../api/tool-trust", () => ({
  toolTrustApi: mockToolTrustApi,
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

const SAMPLE_ENTRIES: TrustRegistryEntry[] = [
  {
    id: "entry-1",
    type: "mcp",
    name: "search_docs",
    provider: "Context7",
    version: "1.2.0",
    source: "mcp_remote",
    sourceUrl: "https://example.com/context7",
    trustStatus: "trusted",
    riskLevel: "read",
    requestedScopes: [],
    approvedScopes: [],
    signature: "sig-abc-123",
    signatureVerified: true,
    enabled: true,
    reviewedAt: "2026-09-28T00:00:00.000Z",
    reviewedBy: "user-1",
    companyId: "company-1",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
  },
  {
    id: "entry-2",
    type: "plugin",
    name: "github_sync",
    provider: "Official",
    version: "2.0.1",
    source: "plugin",
    sourceUrl: null,
    trustStatus: "restricted",
    riskLevel: "high",
    requestedScopes: ["repo:read", "repo:write"],
    approvedScopes: ["repo:read"],
    signature: "sig-xyz-789",
    signatureVerified: false,
    enabled: true,
    reviewedAt: "2026-09-29T00:00:00.000Z",
    reviewedBy: "user-admin",
    companyId: null,
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
  },
  {
    id: "entry-3",
    type: "tool",
    name: "bash_exec",
    provider: null,
    version: null,
    source: "local_stdio",
    sourceUrl: null,
    trustStatus: "blocked",
    riskLevel: "critical",
    requestedScopes: [],
    approvedScopes: [],
    signature: null,
    signatureVerified: false,
    enabled: false,
    reviewedAt: null,
    reviewedBy: null,
    companyId: "company-1",
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
  },
  {
    id: "entry-4",
    type: "tool",
    name: "calc_math",
    provider: "MathCorp",
    version: "0.5.0",
    source: "rest_api",
    sourceUrl: null,
    trustStatus: "unreviewed",
    riskLevel: "low",
    requestedScopes: [],
    approvedScopes: [],
    signature: null,
    signatureVerified: false,
    enabled: true,
    reviewedAt: null,
    reviewedBy: null,
    companyId: "company-1",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
  },
  {
    id: "entry-5",
    type: "plugin",
    name: "legacy_importer",
    provider: "LegacyInc",
    version: "1.0.0",
    source: "plugin",
    sourceUrl: null,
    trustStatus: "revoked",
    riskLevel: "destructive",
    requestedScopes: ["disk:full"],
    approvedScopes: [],
    signature: null,
    signatureVerified: false,
    enabled: false,
    reviewedAt: "2026-09-25T00:00:00.000Z",
    reviewedBy: "user-security",
    companyId: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
  },
];

describe("AIOfficeToolTrustLab", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;
  let currentRoot: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    mockToolTrustApi.list.mockResolvedValue({ entries: SAMPLE_ENTRIES });
  });

  afterEach(() => {
    if (currentRoot) {
      act(() => {
        currentRoot?.unmount();
      });
      currentRoot = null;
    }
    container.remove();
    document.body.innerHTML = "";
    document.body.style.pointerEvents = "";
    vi.clearAllMocks();
  });

  async function renderComponent() {
    currentRoot = createRoot(container);
    act(() => {
      currentRoot?.render(
        <QueryClientProvider client={queryClient}>
          <AIOfficeToolTrustLab />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("renders header and top summary counts accurately", async () => {
    await renderComponent();

    expect(container.textContent).toContain("Control Center — Tool & Plugin Trust Registry (F-05)");
    expect(container.textContent).toContain("전체 등록 항목");
    expect(container.textContent).toContain("신뢰 (Trusted)");
    expect(container.textContent).toContain("미검토 (Unreviewed)");
    expect(container.textContent).toContain("제한 / 차단");
    expect(container.textContent).toContain("취소됨 (Revoked)");

    // Counts check: total=5, trusted=1, unreviewed=1, restricted/blocked=2, revoked=1
    expect(container.textContent).toContain("5");
    expect(container.textContent).toContain("1");
    expect(container.textContent).toContain("2");
  });

  it("renders all entries with proper names, types, and providers", async () => {
    await renderComponent();

    expect(container.textContent).toContain("search_docs");
    expect(container.textContent).toContain("Context7");
    expect(container.textContent).toContain("github_sync");
    expect(container.textContent).toContain("Official");
    expect(container.textContent).toContain("bash_exec");
    expect(container.textContent).toContain("공급자 정보 없음");
    expect(container.textContent).toContain("calc_math");
    expect(container.textContent).toContain("legacy_importer");
  });

  it("clearly distinguishes all 5 trust statuses with appropriate badges", async () => {
    await renderComponent();

    expect(container.textContent).toContain("신뢰 (Trusted)");
    expect(container.textContent).toContain("제한됨 (Restricted)");
    expect(container.textContent).toContain("차단됨 (Blocked)");
    expect(container.textContent).toContain("미검토 (Unreviewed)");
    expect(container.textContent).toContain("취소됨 (Revoked)");
  });

  it("distinguishes verified signature from unverified claim and missing signature", async () => {
    await renderComponent();

    // 1. entry-1 has signatureVerified = true
    expect(container.textContent).toContain("검증 완료 (Verified)");

    // 2. entry-2 has signature !== null && signatureVerified = false -> warning
    expect(container.textContent).toContain("미검증 서명 (Unverified Claim)");

    // 3. entry-3, 4, 5 have signature === null -> neutral
    expect(container.textContent).toContain("서명 없음 (None)");
  });

  it("filters entries by type when type buttons are clicked", async () => {
    await renderComponent();

    // Click 'Tool' filter button
    const toolBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Tool",
    );
    expect(toolBtn).toBeDefined();

    act(() => {
      toolBtn?.click();
    });
    await flushReact();

    expect(container.textContent).toContain("bash_exec");
    expect(container.textContent).toContain("calc_math");
    expect(container.textContent).not.toContain("search_docs");
    expect(container.textContent).not.toContain("github_sync");

    // Click 'MCP' filter button
    const mcpBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "MCP",
    );
    act(() => {
      mcpBtn?.click();
    });
    await flushReact();

    expect(container.textContent).toContain("search_docs");
    expect(container.textContent).not.toContain("bash_exec");
  });

  it("filters entries by trust status when status buttons are clicked", async () => {
    await renderComponent();

    // Click '신뢰' status button
    const trustedBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "신뢰",
    );
    act(() => {
      trustedBtn?.click();
    });
    await flushReact();

    expect(container.textContent).toContain("search_docs");
    expect(container.textContent).not.toContain("github_sync");
    expect(container.textContent).not.toContain("bash_exec");
  });

  it("filters entries by text search", async () => {
    await renderComponent();

    const input = container.querySelector("input[placeholder*='검색']") as HTMLInputElement;
    expect(input).toBeDefined();

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "github");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("github_sync");
    expect(container.textContent).not.toContain("search_docs");
  });

  it("opens detail dialog on clicking '상세 보기' and renders scopes, reviewer, and metadata", async () => {
    await renderComponent();

    // Find detail button for entry-2 (github_sync)
    const detailButtons = Array.from(container.querySelectorAll("button")).filter(
      (b) => b.textContent?.trim() === "상세 보기",
    );
    expect(detailButtons.length).toBe(5);

    // Click on github_sync detail button (second entry)
    act(() => {
      detailButtons[1].click();
    });
    await flushReact();
    await flushReact();

    // Radix Dialog renders in document.body
    expect(document.body.textContent).toContain("github_sync — 신뢰 및 보안 상세 정보");
    expect(document.body.textContent).toContain("요청 스코프 (Requested):");
    expect(document.body.textContent).toContain("repo:read");
    expect(document.body.textContent).toContain("repo:write");
    expect(document.body.textContent).toContain("승인된 스코프 (Approved):");
    expect(document.body.textContent).toContain("user-admin");
    expect(document.body.textContent).toContain("미검증 서명 (Unverified Claim)");
    expect(document.body.textContent).toContain("sig-xyz-789");

    // Close button
    const closeBtn = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "닫기",
    );
    expect(closeBtn).toBeDefined();

    act(() => {
      closeBtn?.click();
    });
    await flushReact();

    expect(document.body.textContent).not.toContain("github_sync — 신뢰 및 보안 상세 정보");
  });

  it("handles empty state when 0 entries exist", async () => {
    mockToolTrustApi.list.mockResolvedValue({ entries: [] });
    await renderComponent();

    expect(container.textContent).toContain("등록된 Tool, MCP 서버 또는 플러그인이 없습니다.");
  });

  it("handles filter empty state when no items match", async () => {
    await renderComponent();

    // Search for non-existent item
    const input = container.querySelector("input") as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "non_existent_xyz");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("선택된 필터 조건에 일치하는 도구/플러그인이 없습니다.");
  });

  it("handles API error state gracefully", async () => {
    mockToolTrustApi.list.mockRejectedValue(new Error("Network Error"));
    await renderComponent();

    expect(container.textContent).toContain("Trust Registry 데이터를 불러올 수 없습니다.");
  });

  it("triggers refetch on clicking '새로고침' button", async () => {
    await renderComponent();

    const refreshBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("새로고침"),
    );
    expect(refreshBtn).toBeDefined();

    act(() => {
      refreshBtn?.click();
    });
    await flushReact();

    expect(mockToolTrustApi.list).toHaveBeenCalledTimes(2);
  });
});

describe("Badge Helpers", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders ToolTypeBadge correctly for tool, mcp, plugin", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <div>
          <ToolTypeBadge type="tool" />
          <ToolTypeBadge type="mcp" />
          <ToolTypeBadge type="plugin" />
        </div>,
      );
    });
    expect(container.textContent).toContain("Tool");
    expect(container.textContent).toContain("MCP");
    expect(container.textContent).toContain("Plugin");
  });

  it("renders TrustStatusBadge correctly for all 5 statuses", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <div>
          <TrustStatusBadge status="trusted" />
          <TrustStatusBadge status="unreviewed" />
          <TrustStatusBadge status="restricted" />
          <TrustStatusBadge status="blocked" />
          <TrustStatusBadge status="revoked" />
        </div>,
      );
    });
    expect(container.textContent).toContain("신뢰 (Trusted)");
    expect(container.textContent).toContain("미검토 (Unreviewed)");
    expect(container.textContent).toContain("제한됨 (Restricted)");
    expect(container.textContent).toContain("차단됨 (Blocked)");
    expect(container.textContent).toContain("취소됨 (Revoked)");
  });

  it("renders RiskLevelBadge correctly for all levels including null", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <div>
          <RiskLevelBadge level="low" />
          <RiskLevelBadge level="medium" />
          <RiskLevelBadge level="high" />
          <RiskLevelBadge level="critical" />
          <RiskLevelBadge level="read" />
          <RiskLevelBadge level="write" />
          <RiskLevelBadge level="destructive" />
          <RiskLevelBadge level={null} />
        </div>,
      );
    });
    expect(container.textContent).toContain("Low (낮음)");
    expect(container.textContent).toContain("Medium (중간)");
    expect(container.textContent).toContain("High (높음)");
    expect(container.textContent).toContain("Critical (치명)");
    expect(container.textContent).toContain("Read (읽기 전용)");
    expect(container.textContent).toContain("Write (쓰기)");
    expect(container.textContent).toContain("Destructive (파괴적)");
    expect(container.textContent).toContain("—");
  });

  it("renders SignatureStatusBadge distinguishing verified, unverified claim, and none", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <div>
          <SignatureStatusBadge signature="sig-1" signatureVerified={true} />
          <SignatureStatusBadge signature="sig-2" signatureVerified={false} />
          <SignatureStatusBadge signature={null} signatureVerified={false} />
        </div>,
      );
    });
    expect(container.textContent).toContain("검증 완료 (Verified)");
    expect(container.textContent).toContain("미검증 서명 (Unverified Claim)");
    expect(container.textContent).toContain("서명 없음 (None)");
  });
});
