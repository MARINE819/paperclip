import { expect, test, type APIRequestContext } from "@playwright/test";

const SCREENSHOT_DIR = "test-results";
const entries = [
  {
    id: "secret-1", type: "secret", provider: "local_encrypted", ownerType: "company",
    ownerId: "company-f02", scope: "company", status: "active", maskedIdentifier: null,
    label: "OpenAI API Key", createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z", lastUsedAt: null, expiresAt: null,
    revokedAt: null, createdBy: "admin-1",
  },
  {
    id: "agent-key-1", type: "agent_api_key", provider: "paperclip", ownerType: "agent",
    ownerId: "agent-f02", scope: "agent", status: "revoked",
    maskedIdentifier: "hash:a1b2c3…9f8e", label: "CI agent key",
    createdAt: "2026-09-03T00:00:00.000Z", updatedAt: null,
    lastUsedAt: null, expiresAt: null, revokedAt: "2026-09-04T00:00:00.000Z", createdBy: null,
  },
  {
    id: "board-key-1", type: "board_api_key", provider: "paperclip", ownerType: "user",
    ownerId: "board-f02", scope: "approval_only", status: "expired",
    maskedIdentifier: "hash:f4e3d2…7b6a", label: null,
    createdAt: "2026-09-05T00:00:00.000Z", updatedAt: null,
    lastUsedAt: null, expiresAt: "2026-09-06T00:00:00.000Z", revokedAt: null, createdBy: null,
  },
];

async function newCompany(request: APIRequestContext): Promise<{ id: string; prefix: string }> {
  const response = await request.post("/api/companies", {
    data: { name: `F02 Secrets UI ${Date.now()}` },
  });
  expect(response.ok(), `isolated company setup failed: ${response.status()}`).toBe(true);
  const company = await response.json();
  return { id: company.id, prefix: company.issuePrefix ?? company.prefix ?? company.urlKey };
}

test.describe("NEXORA F-02 Secrets Control Center UI", () => {
  test.setTimeout(120_000);
  let company: { id: string; prefix: string };

  test.beforeAll(async ({ request }) => {
    company = await newCompany(request);
  });

  test("renders safe projection, detail, empty/error states, and survives reload", async ({ page }) => {
    const consoleErrors: string[] = [];
    const expectedApiErrors: string[] = [];
    const pageErrors: string[] = [];
    let expectingRegistryFailure = false;
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const value = message.text();
      if (expectingRegistryFailure && message.location().url.includes("/api/secrets?"))
        expectedApiErrors.push(value);
      else consoleErrors.push(value);
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    let responseMode: "populated" | "empty" | "error" = "populated";
    await page.route("**/api/secrets?**", async (route) => {
      const url = new URL(route.request().url());
      expect(route.request().method()).toBe("GET");
      expect(url.searchParams.get("companyId")).toBe(company.id);
      await route.fulfill({
        status: responseMode === "error" ? 500 : 200,
        contentType: "application/json",
        body: responseMode === "error"
          ? JSON.stringify({ error: "Isolated test error" })
          : JSON.stringify({ entries: responseMode === "empty" ? [] : entries }),
      });
    });
    await page.route("**/api/secrets/secret-1?**", async (route) => {
      const url = new URL(route.request().url());
      expect(route.request().method()).toBe("GET");
      expect(url.searchParams.get("companyId")).toBe(company.id);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entry: entries[0] }) });
    });

    await page.goto(`/${company.prefix}/ai-office?tab=security`);
    await expect(page.locator("#main-content").getByRole("heading", { name: "AI Office" })).toBeVisible();
    const lab = page.getByTestId("ai-office-secrets-lab");
    await expect(lab.getByText("Control Center — Secrets & Credentials (F-02)")).toBeVisible();
    await expect(lab.getByText("비밀 값은 표시되지 않습니다.", { exact: false })).toBeVisible();
    const summary = lab.getByLabel("Secrets summary");
    for (const [label, count] of [
      ["전체 기록", "3"], ["회사 비밀", "1"], ["에이전트 API 키", "1"], ["내 보드 API 키", "1"],
    ]) {
      await expect(summary.locator(".p-3", { hasText: label }).getByText(count, { exact: true })).toBeVisible();
    }
    const rows = lab.locator("tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: "OpenAI API Key" }).getByText("값 미표시")).toBeVisible();
    await expect(rows.filter({ hasText: "CI agent key" }).getByText("hash:a1b2c3…9f8e")).toBeVisible();
    await expect(rows.filter({ hasText: "CI agent key" }).getByText("revoked")).toBeVisible();
    await expect(rows.filter({ hasText: "이름 없음" }).getByText("hash:f4e3d2…7b6a")).toBeVisible();
    await expect(rows.filter({ hasText: "이름 없음" }).getByText("expired")).toBeVisible();
    await expect(lab).not.toContainText("sk-plaintext-must-never-render-123");
    await lab.screenshot({ path: `${SCREENSHOT_DIR}/f02-secrets-01-loaded.png` });

    await rows.filter({ hasText: "OpenAI API Key" }).getByRole("button", { name: "상세 보기" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("OpenAI API Key — 안전한 상세 정보")).toBeVisible();
    await expect(dialog.getByText("admin-1")).toBeVisible();
    await expect(dialog.getByText("값 미표시")).toBeVisible();
    await expect(dialog).not.toContainText("sk-plaintext-must-never-render-123");
    await expect(dialog.getByRole("button", { name: /생성|편집|회전|폐기|삭제|승인|표시하기/ })).toHaveCount(0);
    await dialog.screenshot({ path: `${SCREENSHOT_DIR}/f02-secrets-02-detail.png` });
    await dialog.getByRole("button", { name: "닫기" }).click();
    await expect(dialog).not.toBeVisible();

    await lab.getByRole("button", { name: "에이전트 API 키", exact: true }).click();
    await expect(rows).toHaveCount(1);
    await lab.getByRole("button", { name: "전체", exact: true }).click();
    await lab.getByRole("textbox", { name: "자격 증명 검색" }).fill("CI agent");
    await expect(rows).toHaveCount(1);
    await lab.getByRole("textbox", { name: "자격 증명 검색" }).clear();

    responseMode = "empty";
    await lab.getByRole("button", { name: "새로고침" }).click();
    await expect(lab.getByText("표시할 비밀 또는 자격 증명 기록이 없습니다.")).toBeVisible();
    await lab.screenshot({ path: `${SCREENSHOT_DIR}/f02-secrets-03-empty.png` });

    responseMode = "error";
    expectingRegistryFailure = true;
    await lab.getByRole("button", { name: "새로고침" }).click();
    await expect(lab.getByRole("alert")).toContainText("Secrets Registry 데이터를 불러올 수 없습니다.");
    await lab.screenshot({ path: `${SCREENSHOT_DIR}/f02-secrets-04-error.png` });
    expectingRegistryFailure = false;

    responseMode = "populated";
    await page.reload();
    await expect(lab.getByText("OpenAI API Key")).toBeVisible();
    await expect(rows).toHaveCount(3);
    expect(consoleErrors, `unexpected console errors: ${consoleErrors.join("\n")}`).toHaveLength(0);
    expect(pageErrors, `page errors: ${pageErrors.join("\n")}`).toHaveLength(0);
    expect(expectedApiErrors.every((value) => value.includes("500"))).toBe(true);
  });
});
