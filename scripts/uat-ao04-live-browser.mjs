import { chromium } from "@playwright/test";

const baseUrl = "http://127.0.0.1:3100";
const errors = [];
let browser;

async function visible(locator, message) {
  await locator.waitFor({ state: "visible", timeout: 15000 });
  if (!(await locator.isVisible())) throw new Error(message);
}

async function run() {
  browser = await chromium.launch({ headless: true });

  try {
    const pc = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });

    pc.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`PC console: ${msg.text()}`);
    });
    pc.on("pageerror", (err) => errors.push(`PC page: ${err.message}`));

    await pc.goto(`${baseUrl}/NEX/ai-office`, {
      waitUntil: "domcontentloaded",
    });

    await visible(
      pc.locator("#main-content").getByRole("heading", { name: "AI Office", exact: true }),
      "AI Office title missing",
    );

    const jarvisRoom = pc
      .locator('div[data-room-type="department"]')
      .filter({ has: pc.getByText("JARVIS 워크스테이션", { exact: true }) });

    await visible(
      jarvisRoom.getByRole("button", { name: /JARVIS/i }),
      "JARVIS workstation missing",
    );

    const cooRoom = pc
      .locator('div[data-room-type="department"]')
      .filter({ has: pc.getByText("COO석", { exact: true }) });

    await visible(
      cooRoom.getByRole("button", { name: /Atlas/i }),
      "Atlas is not inside COO room",
    );

    const metric = pc.locator(
      '[data-testid="desktop-pending-approvals-metric"] span.text-lg',
    );
    await visible(metric, "Pending metric missing");

    const metricValue = (await metric.textContent())?.trim();
    if (metricValue !== "0") {
      throw new Error(`Pending metric expected 0, received ${metricValue}`);
    }

    const rail = pc.locator(
      '[data-testid="desktop-pending-approvals-card"]',
    );
    await visible(rail, "Pending approval rail missing");

    await visible(
      rail.getByText("승인 대기 (0건)", { exact: true }),
      "Exact pending rail count missing",
    );
    await visible(
      rail.getByText("대기 중인 승인 없음", { exact: true }),
      "PC empty state missing",
    );

    await pc.screenshot({
      path: "test-results/live-ai-office-pc.png",
      fullPage: true,
    });

    const mobile = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });

    mobile.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`Mobile console: ${msg.text()}`);
    });
    mobile.on("pageerror", (err) => {
      errors.push(`Mobile page: ${err.message}`);
    });

    await mobile.goto(`${baseUrl}/NEX/mobile/approvals`, {
      waitUntil: "domcontentloaded",
    });

    await visible(
      mobile.locator(
        'button[aria-label="알림음 음소거"], button[aria-label="알림음 켜기"]',
      ),
      "Sound toggle missing",
    );

    await visible(
      mobile.locator("button").filter({
        has: mobile.locator("svg.lucide-refresh-cw"),
      }),
      "Refresh button missing",
    );

    await visible(
      mobile.getByRole("button", {
        name: "즉시 긴급 중지",
        exact: true,
      }),
      "Emergency button missing",
    );

    await visible(
      mobile.getByRole("button", {
        name: "대기 중 (0)",
        exact: true,
      }),
      "Exact mobile pending count missing",
    );

    await visible(
      mobile.getByText("대기 중인 승인 요청이 없습니다.", {
        exact: true,
      }),
      "Mobile empty state missing",
    );

    await mobile.screenshot({
      path: "test-results/live-mobile-approvals.png",
      fullPage: true,
    });

    if (errors.length > 0) {
      throw new Error(errors.join("`n"));
    }

    console.log("AO04_PC_UAT=PASS");
    console.log("AO04_MOBILE_UAT=PASS");
    console.log("AO04_CONSOLE_ERRORS=0");
    console.log("AO04_PAGE_ERRORS=0");
  } finally {
    if (browser) await browser.close();
  }
}

run().catch((error) => {
  console.error("AO04_UAT=FAIL");
  console.error(error.message);
  process.exitCode = 1;
});