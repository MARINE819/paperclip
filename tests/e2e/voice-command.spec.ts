import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// NEXORA Master 1차 — Voice Control live-browser smoke evidence.
// Real microphone hardware is not available in an automated Chromium
// session, so only the SpeechRecognition *constructor* is mocked (it
// synchronously reports a scripted transcript instead of listening to
// real audio) — everything downstream of that (button click, real HTTP
// call to /voice/command, real backend classification/execution, real
// response, real UI render) runs against real code and a real server.

const SCREENSHOT_DIR = "test-results";

type Seed = { companyId: string; prefix: string };

async function newCompany(request: APIRequestContext, label: string): Promise<Seed> {
  const res = await request.post("/api/companies", { data: { name: `Voice ${label} ${Date.now()}` } });
  expect(res.ok(), `create company failed ${res.status()}: ${await res.text()}`).toBe(true);
  const company = await res.json();
  return {
    companyId: company.id,
    prefix: company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E",
  };
}

/**
 * Installs a mock SpeechRecognition constructor before any page script runs.
 * `window.__nextVoiceTranscript` is read once per `.start()` call and fed to
 * `onresult` on the next microtask, mirroring the real API's async result
 * delivery closely enough for VoiceCommandBar's handler to behave the same
 * as it would with a genuine browser recognition result.
 */
async function installMockSpeechRecognition(page: Page) {
  await page.addInitScript(() => {
    class MockSpeechRecognition {
      lang = "";
      interimResults = false;
      onresult: ((event: { results: { 0: { 0: { transcript: string } } }[] }) => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        const transcript = (window as unknown as { __nextVoiceTranscript?: string }).__nextVoiceTranscript ?? "";
        setTimeout(() => {
          this.onresult?.({ results: [{ 0: { transcript } } as never] });
          this.onend?.();
        }, 0);
      }
    }
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = MockSpeechRecognition;
  });
}

async function speakAndWait(page: Page, main: ReturnType<Page["locator"]>, transcript: string) {
  await page.evaluate((t) => {
    (window as unknown as { __nextVoiceTranscript: string }).__nextVoiceTranscript = t;
  }, transcript);
  await main.getByRole("button", { name: "Start voice command" }).click();
}

test.describe("Voice Control — live browser evidence", () => {
  test.setTimeout(120_000);

  let seed: Seed;

  test.beforeAll(async ({ request }) => {
    seed = await newCompany(request, "smoke");
  });

  test("safe read command returns real backend data; dangerous command only requests approval, never executes", async ({
    page,
    request,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await installMockSpeechRecognition(page);
    await page.goto(`/${seed.prefix}/ai-office`);
    const main = page.locator("#main-content");
    await expect(main.getByRole("heading", { name: "AI Office" })).toBeVisible({ timeout: 30_000 });

    const micButton = main.getByRole("button", { name: "Start voice command" });
    await expect(micButton).toBeVisible({ timeout: 15_000 });

    // 1. Safe read command — real transcript -> real API -> real response.
    await speakAndWait(page, main, "company status");
    await expect(main.getByText(/현재 상태는/)).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/voice-01-status-company.png`, fullPage: true });

    // Confirm the company is genuinely still active before the dangerous test.
    const beforeCompany = await request.get(`/api/companies/${seed.companyId}`);
    expect((await beforeCompany.json()).status).toBe("active");

    // 2. Dangerous command — must only request an approval, never pause.
    await speakAndWait(page, main, "pause company");
    await expect(main.getByText("Approval requested")).toBeVisible({ timeout: 15_000 });
    await expect(
      main.getByText(/The company has not been paused/),
    ).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/voice-02-dangerous-approval-requested.png`, fullPage: true });

    const afterCompany = await request.get(`/api/companies/${seed.companyId}`);
    expect((await afterCompany.json()).status, "voice command must never auto-pause the company").toBe("active");

    const approvals = await request.get(`/api/companies/${seed.companyId}/approvals?status=pending`);
    const approvalsBody = await approvals.json();
    expect(approvalsBody.length, "exactly one pending approval from the voice command, no duplicates").toBe(1);
    expect(approvalsBody[0].payload.action).toBe("pause_company");
    expect(approvalsBody[0].payload.requestedVia).toBe("voice");

    // 3. Reload — bar returns to its idle baseline, no stale/frozen state.
    await page.reload();
    await expect(main.getByRole("heading", { name: "AI Office" })).toBeVisible({ timeout: 30_000 });
    await expect(main.getByRole("button", { name: "Start voice command" })).toBeVisible({ timeout: 15_000 });

    expect(pageErrors, `uncaught page errors: ${pageErrors.join("\n")}`).toHaveLength(0);
    expect(consoleErrors, `console errors: ${consoleErrors.join("\n")}`).toHaveLength(0);
  });
});
