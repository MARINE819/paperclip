import { expect, test, type Page } from "@playwright/test";

// NEXORA JARVIS Neural Command Interface — Phase 1.5 Pure Read-Only Browser UAT
// STRICT INVARIANTS:
// - ZERO database or server mutations (NO POST, NO PUT, NO PATCH, NO DELETE).
// - ZERO test seeds created. Reads only existing live company/data.
// - Phase 2B: this real company now has a real GET /neural-routes backend, so
//   these tests assert the TRUTHFUL post-confirmation state (source="live",
//   pending banner gone) rather than the old Phase 2A "always pending"
//   invariant. Route/provider/model node content can still legitimately fall
//   back to frontend fixtures before that response resolves, or for any
//   agent the backend has no telemetry for yet.
// - Verifies Desktop (1280x800), Tablet (768x1024), iPhone (390x844), Android (360x800).
// - Verifies mobile staged drilldown (Core -> Team -> Agent -> Execution) and back navigation.
// - Verifies keyboard navigation, ARIA attributes, and reduced-motion tolerance.

test.use({
  baseURL: "http://127.0.0.1:3100",
});

let companyPrefix = "NEX";

const NEURAL_ROUTES_URL_PATTERN = /\/api\/companies\/[^/]+\/neural-routes(?:\?|$)/;
const LIVE_SOURCE_BADGE_TEXT = "실시간 백엔드 라우팅 텔레메트리 (연동 완료)";

/**
 * Deterministically waits for the real backend neural-routes GET this page
 * actually issues — never an arbitrary sleep. Must be called BEFORE the
 * action that triggers the Neural view's mount (button click or goto),
 * otherwise the response may already have fired and this would hang.
 */
function waitForNeuralRoutesResponse(page: Page) {
  return page.waitForResponse(
    (response) => response.request().method() === "GET" && NEURAL_ROUTES_URL_PATTERN.test(response.url()),
    { timeout: 15_000 },
  );
}

test.beforeAll(async ({ request }) => {
  // Read-only GET to discover existing company prefix
  try {
    const res = await request.get("/api/companies");
    if (res.ok()) {
      const list = await res.json();
      if (Array.isArray(list) && list.length > 0) {
        const target = list.find((c: { name: string }) => c.name?.includes("NEXORA")) ?? list[0];
        companyPrefix = target.issuePrefix ?? target.prefix ?? target.urlKey ?? "NEX";
      }
    }
  } catch (err) {
    console.warn("Failed to fetch companies list in beforeAll, using prefix:", companyPrefix, err);
  }
});

test.describe("JARVIS Neural Command Interface — Pure Read-Only Browser & Responsive UAT", () => {
  test.setTimeout(60_000);

  test("1. Desktop (1280x800): Default 2D Office, switch to Neural Map, and return", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });

    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    // 1-1. Visit existing AI Office
    await page.goto(`/${companyPrefix}/ai-office`);
    await page.waitForLoadState("domcontentloaded");

    // 1-2. Verify 2D Office is default
    const floorBtn = page.locator("[data-testid='view-mode-floor-btn']");
    const neuralBtn = page.locator("[data-testid='view-mode-neural-btn']");
    await expect(floorBtn).toBeVisible({ timeout: 15_000 });
    await expect(neuralBtn).toBeVisible({ timeout: 15_000 });
    await expect(floorBtn).toHaveAttribute("aria-pressed", "true");
    await expect(neuralBtn).toHaveAttribute("aria-pressed", "false");

    // 1-3. Switch to JARVIS Neural Map. The response wait must be armed
    // BEFORE the click that triggers the Neural view's mount/fetch.
    const neuralRoutesResponsePromise = waitForNeuralRoutesResponse(page);
    await neuralBtn.click();
    await expect(neuralBtn).toHaveAttribute("aria-pressed", "true");
    await expect(floorBtn).toHaveAttribute("aria-pressed", "false");

    // 1-4. Verify Neural Map is rendered
    const neuralMap = page.locator("[data-testid='jarvis-neural-command-interface']");
    await expect(neuralMap).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("JARVIS Neural Command Map")).toBeVisible();

    // 1-5. Verify Central JARVIS Core
    const centralCore = page.locator("[data-testid='central-jarvis-core']:visible");
    await expect(centralCore).toBeVisible();
    await expect(centralCore.getByText("JARVIS Core")).toBeVisible();

    // 1-6. Verify Team Ring nodes do not overlap
    const teamRing = page.locator("[data-testid='team-ring']:visible");
    await expect(teamRing).toBeVisible();
    await expect(teamRing.getByText("기획·전략팀")).toBeVisible();
    await expect(teamRing.getByText("개발팀")).toBeVisible();

    // 1-7. Verify ExecutionRoutePanel and router nodes. Route/provider/model
    // content can legitimately still come from frontend fixtures here
    // (per-agent content is independent of the company-wide live
    // confirmation below).
    const routePanel = page.locator("[data-testid='execution-route-panel']:visible");
    await expect(routePanel).toBeVisible();
    await expect(page.locator("[data-testid='executor-node']:visible")).toBeVisible();
    await expect(page.locator("[data-testid='provider-node']:visible")).toBeVisible();
    await expect(page.locator("[data-testid='model-node']:visible")).toBeVisible();

    // 1-7b. Phase 2B truthful provenance: this real company's neural-routes
    // GET must actually resolve 200, the source badge must show real live
    // confirmation text, and the pending banner must be gone — never both
    // ("live OR pending") for this real-company path.
    const neuralRoutesResponse = await neuralRoutesResponsePromise;
    expect(neuralRoutesResponse.status()).toBe(200);
    await expect(page.locator("[data-testid='neural-source-badge']:visible").first()).toContainText(
      LIVE_SOURCE_BADGE_TEXT,
    );
    await expect(page.locator("[data-testid='backend-pending-banner']")).not.toBeVisible();

    // 1-8. Verify no horizontal overflow on desktop
    const hasHorizontalScroll = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(hasHorizontalScroll).toBe(false);

    // 1-9. Switch back to 2D Office
    await floorBtn.click();
    await expect(floorBtn).toHaveAttribute("aria-pressed", "true");
    await expect(neuralMap).not.toBeVisible();

    expect(consoleErrors).toHaveLength(0);
  });

  test("2. Direct URL entry (?view=neural) renders Neural Map directly", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.goto(`/${companyPrefix}/ai-office?view=neural`);
    await page.waitForLoadState("domcontentloaded");

    const neuralBtn = page.locator("[data-testid='view-mode-neural-btn']");
    await expect(neuralBtn).toBeVisible({ timeout: 15_000 });
    await expect(neuralBtn).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-testid='jarvis-neural-command-interface']")).toBeVisible();
  });

  test("3. Tablet Viewport (768x1024): Responsive layout & zero horizontal overflow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 768, height: 1024 });

    await page.goto(`/${companyPrefix}/ai-office?view=neural`);
    await page.waitForLoadState("domcontentloaded");

    const neuralMap = page.locator("[data-testid='jarvis-neural-command-interface']");
    await expect(neuralMap).toBeVisible({ timeout: 15_000 });

    // Verify zero horizontal overflow on tablet
    const hasHorizontalScroll = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(hasHorizontalScroll).toBe(false);

    await expect(page.locator("[data-testid='central-jarvis-core']:visible")).toBeVisible();
    await expect(page.locator("[data-testid='execution-route-panel']:visible")).toBeVisible();
  });

  test("4. iPhone Portrait (390x844): Mobile Staged Drill-Down and Back Navigation", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    // Response wait must be armed BEFORE goto: ?view=neural mounts the
    // Neural view (and its fetch) immediately on load.
    const neuralRoutesResponsePromise = waitForNeuralRoutesResponse(page);
    await page.goto(`/${companyPrefix}/ai-office?view=neural`);
    await page.waitForLoadState("domcontentloaded");

    const mobileNav = page.locator("[data-testid='mobile-neural-navigator']");
    await expect(mobileNav).toBeVisible({ timeout: 15_000 });

    // Stage 1: Core view
    await expect(page.locator("[data-testid='mobile-stage-core']")).toBeVisible();
    const teamBtn = page.locator("[data-testid^='mobile-team-btn-']").first();
    await expect(teamBtn).toBeVisible();

    // Verify zero horizontal scroll
    let hasHorizontalScroll = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(hasHorizontalScroll).toBe(false);

    // Stage 2: Drill down to Team view
    await teamBtn.click();
    const teamStage = page.locator("[data-testid='mobile-stage-team']");
    await expect(teamStage).toBeVisible();
    await expect(teamStage.getByText("에이전트 선택")).toBeVisible();

    // Stage 3/4: Drill down to Execution Detail
    const agentNode = teamStage.locator("[data-testid^='agent-node-']").first();
    await expect(agentNode).toBeVisible();
    await agentNode.click();

    const execStage = page.locator("[data-testid='mobile-stage-execution']");
    await expect(execStage).toBeVisible();
    await expect(
      execStage
        .locator("[data-testid='execution-route-panel']")
        .or(execStage.getByText("선택된 에이전트의 활성 라우팅 정보가 없습니다.")),
    ).toBeVisible();

    // Phase 2B truthful provenance (mobile): same real-company live
    // confirmation as desktop — never "live OR pending" for this path.
    const neuralRoutesResponse = await neuralRoutesResponsePromise;
    expect(neuralRoutesResponse.status()).toBe(200);
    await expect(page.locator("[data-testid='neural-source-badge']:visible").first()).toContainText(
      LIVE_SOURCE_BADGE_TEXT,
    );
    await expect(page.locator("[data-testid='backend-pending-banner']")).not.toBeVisible();

    // Verify zero horizontal scroll on execution stage
    hasHorizontalScroll = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(hasHorizontalScroll).toBe(false);

    // Back navigation: return to Team, then return to Core
    const backToTeamBtn = page.getByRole("button", { name: /에이전트 목록으로/ });
    await expect(backToTeamBtn).toBeVisible();
    await backToTeamBtn.click();
    await expect(page.locator("[data-testid='mobile-stage-team']")).toBeVisible();

    const backToCoreBtn = page.getByRole("button", { name: /코어로 돌아가기/ });
    await expect(backToCoreBtn).toBeVisible();
    await backToCoreBtn.click();
    await expect(page.locator("[data-testid='mobile-stage-core']")).toBeVisible();
  });

  test("5. Android Portrait (360x800): Compact viewport check without horizontal scroll", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });

    await page.goto(`/${companyPrefix}/ai-office?view=neural`);
    await page.waitForLoadState("domcontentloaded");

    await expect(page.locator("[data-testid='mobile-neural-navigator']")).toBeVisible({ timeout: 15_000 });

    const hasHorizontalScroll = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(hasHorizontalScroll).toBe(false);
  });

  test("6. Accessibility: Keyboard view switch, ARIA attributes, and reduced-motion", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });

    await page.goto(`/${companyPrefix}/ai-office`);
    await page.waitForLoadState("domcontentloaded");

    const floorBtn = page.locator("[data-testid='view-mode-floor-btn']");
    const neuralBtn = page.locator("[data-testid='view-mode-neural-btn']");

    // Keyboard activation: focus neural button and press Enter
    await neuralBtn.focus();
    await page.keyboard.press("Enter");

    await expect(neuralBtn).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-testid='jarvis-neural-command-interface']")).toBeVisible();

    // Keyboard activation: focus floor button and press Enter
    await floorBtn.focus();
    await page.keyboard.press("Enter");

    await expect(floorBtn).toHaveAttribute("aria-pressed", "true");
  });
});
