import { expect, test, type APIRequestContext } from "@playwright/test";

// NEXORA F-05 — Tool / Plugin Trust Registry Browser E2E verification
// Tests end-to-end:
// 1. Live page load on /ai-office
// 2. Control Center Tool & Plugin Trust Registry Lab header & description (F-05)
// 3. Top Summary Cards (전체: 5, 신뢰: 1, 미검토: 1, 제한/차단: 2, 취소됨: 1)
// 4. Inventory Table with Tool / MCP / Plugin entries
// 5. Trust Status badges (trusted, unreviewed, restricted, blocked, revoked)
// 6. Risk Level badges (read, high, critical, low, destructive)
// 7. Signature State badges:
//    - signatureVerified = true ("검증 완료 (Verified)")
//    - signatureVerified = false && signature != null ("미검증 서명 (Unverified Claim)")
//    - signature = null ("서명 없음 (None)")
// 8. Filter buttons (Type filters and Status filters)
// 9. Detail Dialog inspection (requested/approved scopes, reviewer, signature, metadata)
// 10. Empty state handling (0 entries)
// 11. API 500 error state handling
// 12. Page reload stability (page.reload())
// 13. Zero console errors & zero page errors

const SCREENSHOT_DIR = "test-results";

type Seed = { companyId: string; prefix: string };

async function newCompany(request: APIRequestContext, label: string): Promise<Seed> {
  const res = await request.post("/api/companies", {
    data: { name: `F05 Tool Trust UI ${label} ${Date.now()}` },
  });
  expect(res.ok(), `create company failed ${res.status()}: ${await res.text()}`).toBe(true);
  const company = await res.json();
  return {
    companyId: company.id,
    prefix: company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E",
  };
}

const MOCK_TRUST_ENTRIES = [
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
    signature: "sig-verified-123",
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
    signature: "sig-unverified-456",
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

test.describe("NEXORA F-05 Tool / Plugin Trust Registry Control Center UI", () => {
  test.setTimeout(120_000);

  let seed: Seed;

  test.beforeAll(async ({ request }) => {
    seed = await newCompany(request, "tool-trust-ui");

    const agentRes = await request.post(`/api/companies/${seed.companyId}/agents`, {
      data: {
        name: "JARVIS",
        role: "ceo",
        title: "CTO / Orchestrator",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      },
    });
    expect(agentRes.ok(), `create agent failed ${agentRes.status()}: ${await agentRes.text()}`).toBe(true);
  });

  test("renders summary cards, inventory table, distinct signature states, filters, detail dialog, survives reload with 0 errors", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const expectedApiErrors: string[] = [];
    const pageErrors: string[] = [];
    let expectingRegistryFailure = false;
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (expectingRegistryFailure && msg.location().url.includes("/api/tools/trust-registry"))
          expectedApiErrors.push(text);
        else consoleErrors.push(text);
      }
    });
    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    // 1. Intercept Tool Trust Registry API
    await page.route("**/api/tools/trust-registry**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ entries: MOCK_TRUST_ENTRIES }),
      });
    });

    // 2. Navigate to AI Office
    await page.goto(`/${seed.prefix}/ai-office?tab=security`);
    const main = page.locator("#main-content");
    await expect(main.getByRole("heading", { name: "AI Office" })).toBeVisible({ timeout: 30_000 });

    // 3. Verify Control Center Tool Trust Lab component loaded
    const trustHeader = page.getByText("Control Center — Tool & Plugin Trust Registry (F-05)");
    await expect(trustHeader).toBeVisible({ timeout: 15_000 });
    const trustLab = trustHeader.locator("xpath=ancestor::div[contains(@class, 'space-y-4')][1]");

    // 4. Verify Summary Cards
    const summaryCards = trustLab.locator(".grid.grid-cols-2.gap-3.sm\\:grid-cols-5");
    await expect(summaryCards).toBeVisible();
    await expect(summaryCards.getByText("전체 등록 항목")).toBeVisible();
    await expect(summaryCards.getByText("신뢰 (Trusted)")).toBeVisible();
    await expect(summaryCards.getByText("미검토 (Unreviewed)")).toBeVisible();
    await expect(summaryCards.getByText("제한 / 차단")).toBeVisible();
    await expect(summaryCards.getByText("취소됨 (Revoked)")).toBeVisible();

    for (const [label, count] of [
      ["전체 등록 항목", "5"],
      ["신뢰 (Trusted)", "1"],
      ["미검토 (Unreviewed)", "1"],
      ["제한 / 차단", "2"],
      ["취소됨 (Revoked)", "1"],
    ]) {
      await expect(summaryCards.locator(".p-3", { hasText: label }).getByText(count, { exact: true })).toBeVisible();
    }

    // 5. Verify Inventory Table Items & Badges
    await expect(trustLab.getByText("search_docs")).toBeVisible();
    await expect(trustLab.getByText("Context7")).toBeVisible();
    await expect(trustLab.getByText("github_sync")).toBeVisible();
    await expect(trustLab.getByText("bash_exec")).toBeVisible();
    await expect(trustLab.getByText("calc_math")).toBeVisible();
    await expect(trustLab.getByText("legacy_importer")).toBeVisible();

    for (const [name, trust, risk, signature, enabled] of [
      ["search_docs", "신뢰 (Trusted)", "Read (읽기 전용)", "검증 완료 (Verified)", "활성"],
      ["github_sync", "제한됨 (Restricted)", "High (높음)", "미검증 서명 (Unverified Claim)", "활성"],
      ["bash_exec", "차단됨 (Blocked)", "Critical (치명)", "서명 없음 (None)", "비활성"],
      ["calc_math", "미검토 (Unreviewed)", "Low (낮음)", "서명 없음 (None)", "활성"],
      ["legacy_importer", "취소됨 (Revoked)", "Destructive (파괴적)", "서명 없음 (None)", "비활성"],
    ]) {
      const row = trustLab.locator("tr", { hasText: name });
      await expect(row.getByText(trust, { exact: true })).toBeVisible();
      await expect(row.getByText(risk, { exact: true })).toBeVisible();
      await expect(row.getByText(signature, { exact: true })).toBeVisible();
      await expect(row.getByText(enabled, { exact: true })).toBeVisible();
    }

    await page.screenshot({ path: `${SCREENSHOT_DIR}/f05-tool-trust-01-loaded.png`, fullPage: true });

    // 6. Test Filtering
    // Click 'Plugin' filter
    const pluginFilterBtn = trustLab.getByRole("button", { name: "Plugin" });
    await pluginFilterBtn.click();
    await expect(trustLab.getByText("github_sync")).toBeVisible();
    await expect(trustLab.getByText("legacy_importer")).toBeVisible();
    await expect(trustLab.getByText("search_docs")).not.toBeVisible();
    await expect(trustLab.getByText("bash_exec")).not.toBeVisible();

    // Reset filter: Click '전체' type filter
    const allTypeFilterBtn = trustLab.getByRole("button", { name: "전체" }).first();
    await allTypeFilterBtn.click();
    await expect(trustLab.getByText("search_docs")).toBeVisible();

    await trustLab.getByRole("button", { name: "차단", exact: true }).click();
    await expect(trustLab.getByText("bash_exec")).toBeVisible();
    await expect(trustLab.getByText("search_docs")).not.toBeVisible();
    await trustLab.getByRole("button", { name: "전체" }).last().click();
    const search = trustLab.getByPlaceholder("이름, 공급자, 전송 검색...");
    await search.fill("Context7");
    await expect(trustLab.getByText("search_docs")).toBeVisible();
    await expect(trustLab.getByText("github_sync")).not.toBeVisible();
    await search.clear();

    // 7. Test Detail Dialog Inspection (github_sync)
    const githubRow = trustLab.locator("tr", { hasText: "github_sync" });
    await expect(githubRow).toBeVisible();
    const detailBtn = githubRow.getByRole("button", { name: "상세 보기" });
    await detailBtn.click();

    // Verify Dialog content
    const detailDialog = page.locator("[role='dialog']");
    await expect(detailDialog.getByText("github_sync — 신뢰 및 보안 상세 정보")).toBeVisible({ timeout: 10_000 });
    await expect(detailDialog.getByText("요청 스코프 (Requested):")).toBeVisible();
    await expect(detailDialog.getByText("repo:read").first()).toBeVisible();
    await expect(detailDialog.getByText("repo:write")).toBeVisible();
    await expect(detailDialog.getByText("승인된 스코프 (Approved):")).toBeVisible();
    await expect(detailDialog.getByText("user-admin")).toBeVisible();
    await expect(detailDialog.getByText("v2.0.1")).toBeVisible();
    await expect(detailDialog.getByText("2026", { exact: false })).toBeVisible();
    await expect(detailDialog.getByText("미검증 서명 (Unverified Claim)")).toBeVisible();
    await expect(detailDialog.locator("pre").getByText("sig-unverified-456")).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOT_DIR}/f05-tool-trust-02-detail-dialog.png`, fullPage: true });

    // Close Dialog using '닫기' button
    const closeBtn = detailDialog.getByRole("button", { name: "닫기" });
    await closeBtn.click();
    await expect(detailDialog).not.toBeVisible({ timeout: 5000 });

    // 8. Test Empty State Handling (0 entries)
    await page.unroute("**/api/tools/trust-registry**");
    await page.route("**/api/tools/trust-registry**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ entries: [] }),
      });
    });

    const refreshBtn = trustLab.getByRole("button", { name: /새로고침/ });
    await refreshBtn.click();

    await expect(page.getByText("등록된 Tool, MCP 서버 또는 플러그인이 없습니다.")).toBeVisible({ timeout: 10_000 });

    await page.screenshot({ path: `${SCREENSHOT_DIR}/f05-tool-trust-03-empty-state.png`, fullPage: true });

    // 9. Test API 500 Error State Handling
    await page.unroute("**/api/tools/trust-registry**");
    await page.route("**/api/tools/trust-registry**", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Internal Server Error" }),
      });
    });

    expectingRegistryFailure = true;
    await refreshBtn.click();
    await expect(page.getByText("Trust Registry 데이터를 불러올 수 없습니다.")).toBeVisible({ timeout: 10_000 });

    await page.screenshot({ path: `${SCREENSHOT_DIR}/f05-tool-trust-04-api-error.png`, fullPage: true });
    expectingRegistryFailure = false;

    // 10. Test Reload Stability
    await page.unroute("**/api/tools/trust-registry**");
    await page.route("**/api/tools/trust-registry**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ entries: MOCK_TRUST_ENTRIES }),
      });
    });

    await page.reload();
    await expect(main.getByRole("heading", { name: "AI Office" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Control Center — Tool & Plugin Trust Registry (F-05)")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("search_docs")).toBeVisible();

    // 11. Assert 0 uncaught console errors and 0 page errors
    expect(pageErrors, `uncaught page errors: ${pageErrors.join("\n")}`).toHaveLength(0);
    expect(consoleErrors, `console errors: ${consoleErrors.join("\n")}`).toHaveLength(0);
    expect(expectedApiErrors.every((error) => error.includes("500"))).toBe(true);
  });
});
