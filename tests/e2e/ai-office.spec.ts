import { expect, test, type APIRequestContext } from "@playwright/test";

// NEXORA Master 1차 — AI Office 2D live-browser smoke evidence.
// Confirms /ai-office actually loads real agent/org-unit data end to end in
// a real Chromium session (not just jsdom unit tests): page renders, a real
// agent (JARVIS, exact-name leadership seat) is clickable and opens the
// detail sheet, zero console/page errors, and state survives a reload.

const SCREENSHOT_DIR = "test-results";

type Seed = { companyId: string; prefix: string };

async function newCompany(request: APIRequestContext, label: string): Promise<Seed> {
  const res = await request.post("/api/companies", { data: { name: `AI Office ${label} ${Date.now()}` } });
  expect(res.ok(), `create company failed ${res.status()}: ${await res.text()}`).toBe(true);
  const company = await res.json();
  return {
    companyId: company.id,
    prefix: company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E",
  };
}

test.describe("AI Office 2D — live browser evidence", () => {
  test.setTimeout(120_000);

  let seed: Seed;
  let jarvisAgentId: string;

  test.beforeAll(async ({ request }) => {
    seed = await newCompany(request, "smoke");

    const agentRes = await request.post(`/api/companies/${seed.companyId}/agents`, {
      data: {
        name: "JARVIS",
        role: "ceo",
        title: "CTO / Orchestrator",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      },
    });
    expect(agentRes.ok(), `create JARVIS failed ${agentRes.status()}: ${await agentRes.text()}`).toBe(true);
    const agent = await agentRes.json();
    jarvisAgentId = agent.id as string;
  });

  test("loads real agent/org data, JARVIS seat is clickable, no console errors, survives reload", async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    await page.goto(`/${seed.prefix}/ai-office`);
    const main = page.locator("#main-content");
    await expect(main.getByRole("heading", { name: "AI Office" })).toBeVisible({ timeout: 30_000 });

    // JARVIS workstation renders from real agent data (exact-name leadership seat).
    // Scoped to #main-content: the sidebar also has an unrelated "Open actions
    // for JARVIS" button whose accessible name matches a loose /JARVIS/ query.
    const jarvisSeat = main.locator('[data-room-type="department"]').getByRole("button", { name: /JARVIS/ });
    await expect(jarvisSeat).toBeVisible({ timeout: 30_000 });

    await page.screenshot({ path: `${SCREENSHOT_DIR}/ai-office-01-loaded.png`, fullPage: true });

    // Click opens the (data-only) detail sheet — real Agent Interaction. The
    // Dashboard link's href is the strongest signal: it proves the sheet
    // resolved to the exact agent whose seat was clicked, not just any sheet.
    await jarvisSeat.click();
    const dashboardLink = page.getByRole("link", { name: /Dashboard에서 상세 보기/ });
    await expect(dashboardLink).toBeVisible({ timeout: 10_000 });
    await expect(dashboardLink).toHaveAttribute("href", `/agents/${jarvisAgentId}`);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/ai-office-02-detail-sheet.png`, fullPage: true });

    // Reload — state must be re-derived from live data, not lost/frozen.
    await page.reload();
    await expect(main.getByRole("heading", { name: "AI Office" })).toBeVisible({ timeout: 30_000 });
    await expect(main.locator('[data-room-type="department"]').getByRole("button", { name: /JARVIS/ })).toBeVisible({ timeout: 30_000 });

    expect(pageErrors, `uncaught page errors: ${pageErrors.join("\n")}`).toHaveLength(0);
    expect(consoleErrors, `console errors: ${consoleErrors.join("\n")}`).toHaveLength(0);
  });
});
