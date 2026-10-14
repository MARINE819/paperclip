import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

/**
 * Mobile Governance Navigation End-to-End UAT (Commit 436b6e72f)
 *
 * Verifies mobile executive governance navigation loop at:
 * - 390x844 (iPhone 12/13/14 standard mobile viewport)
 * - 360x800 (Android modern compact mobile viewport)
 *
 * Requirements:
 * 1. Discover existing company prefix via read-only GET /api/companies (no seed/mutations).
 * 2. Open prefixed AI Office summary route (?view=summary).
 * 3. Verify mobile summary and governance header.
 * 4. Click mobile-header-approvals-link and verify /<prefix>/mobile/approvals.
 * 5. Verify mobile-console-summary-link and mobile-console-settings-link.
 * 6. Click mobile-console-summary-link and verify return to summary.
 * 7. Navigate to mobile settings through approved settings link (/<prefix>/mobile/settings).
 * 8. At every page, assert documentElement.scrollWidth <= window.innerWidth.
 * 9. Collect console errors and page errors, requiring zero at test completion.
 * 10. Run same journey independently at both viewports.
 */

const VIEWPORTS = [
  { name: '390x844', width: 390, height: 844 },
  { name: '360x800', width: 360, height: 800 },
] as const;

function getBaseUrl(baseURL?: string): string {
  if (baseURL) return baseURL.replace(/\/+$/, '');
  if (process.env.PAPERCLIP_E2E_BASE_URL) return process.env.PAPERCLIP_E2E_BASE_URL.replace(/\/+$/, '');
  const port = process.env.PAPERCLIP_E2E_PORT || process.env.PORT || '3100';
  return `http://127.0.0.1:${port}`;
}

async function discoverCompanyPrefix(request: APIRequestContext, base: string): Promise<string> {
  const res = await request.get(`${base}/api/companies`);
  if (!res.ok()) {
    throw new Error(`Precondition failure: /api/companies returned HTTP ${res.status()}`);
  }
  const body = await res.json();
  const companies = Array.isArray(body)
    ? body
    : Array.isArray(body?.companies)
      ? body.companies
      : Array.isArray(body?.data)
        ? body.data
        : [];

  if (companies.length === 0) {
    throw new Error('Precondition failed: No existing company available. Do not seed data.');
  }

  const company = companies[0];
  const prefix = company.issuePrefix ?? company.id;
  if (!prefix) {
    throw new Error('Precondition failed: Discovered company has no issuePrefix or id.');
  }
  return prefix;
}

async function assertNoHorizontalOverflow(page: Page, locationName: string) {
  await page.waitForTimeout(100);
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(
    scrollWidth,
    `Horizontal overflow detected at [${locationName}]: documentElement.scrollWidth (${scrollWidth}) > window.innerWidth (${innerWidth})`,
  ).toBeLessThanOrEqual(innerWidth);
}

for (const vp of VIEWPORTS) {
  test.describe(`Mobile Governance Journey (${vp.name})`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test(`completes navigation loop with zero horizontal overflow and zero errors at ${vp.name}`, async ({
      page,
      request,
      baseURL,
    }) => {
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];

      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          consoleErrors.push(msg.text());
        }
      });

      page.on('pageerror', (err) => {
        pageErrors.push(err.message || String(err));
      });

      await page.setViewportSize({ width: vp.width, height: vp.height });
      const base = getBaseUrl(baseURL);

      // Step 1 & 2: Discover existing company prefix using read-only GET pattern
      const prefix = await discoverCompanyPrefix(request, base);

      // Step 3: Open prefixed AI Office summary route with ?view=summary
      await page.goto(`${base}/${prefix}/ai-office?view=summary`);
      await page.waitForLoadState('domcontentloaded');

      // Step 4: Verify mobile summary and governance header
      const summary = page.getByTestId('ai-office-mobile-summary');
      await expect(summary).toBeVisible({ timeout: 20_000 });
      const header = page.getByTestId('mobile-governance-header');
      await expect(header).toBeVisible({ timeout: 20_000 });
      await assertNoHorizontalOverflow(page, `AI Office Summary (${vp.name})`);

      // Step 5: Click mobile-header-approvals-link and verify /<prefix>/mobile/approvals
      const approvalsLink = page.getByTestId('mobile-header-approvals-link');
      await expect(approvalsLink).toBeVisible({ timeout: 20_000 });
      await approvalsLink.click();
      await page.waitForURL((url) => url.pathname === `/${prefix}/mobile/approvals`, { timeout: 20_000 });
      expect(new URL(page.url()).pathname).toBe(`/${prefix}/mobile/approvals`);
      await assertNoHorizontalOverflow(page, `Mobile Approvals Console (${vp.name})`);

      // Step 6: Verify mobile-console-summary-link and mobile-console-settings-link
      const consoleSummaryLink = page.getByTestId('mobile-console-summary-link');
      await expect(consoleSummaryLink).toBeVisible({ timeout: 20_000 });
      const consoleSettingsLink = page.getByTestId('mobile-console-settings-link');
      await expect(consoleSettingsLink).toBeVisible({ timeout: 20_000 });

      // Step 7: Click mobile-console-summary-link and verify return to the summary
      await consoleSummaryLink.click();
      await page.waitForURL(
        (url) => url.pathname === `/${prefix}/ai-office` && url.searchParams.get('view') === 'summary',
        { timeout: 20_000 },
      );
      const summaryUrl = new URL(page.url());
      expect(summaryUrl.pathname).toBe(`/${prefix}/ai-office`);
      expect(summaryUrl.searchParams.get('view')).toBe('summary');
      await expect(page.getByTestId('ai-office-mobile-summary')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('mobile-governance-header')).toBeVisible({ timeout: 20_000 });
      await assertNoHorizontalOverflow(page, `Return to AI Office Summary (${vp.name})`);

      // Step 8: Navigate to mobile settings through the approved settings link
      const settingsLink = page
        .getByTestId('mobile-header-settings-link')
        .or(page.getByTestId('mobile-console-settings-link'))
        .first();
      await expect(settingsLink).toBeVisible({ timeout: 20_000 });
      await settingsLink.click();
      await page.waitForURL((url) => url.pathname === `/${prefix}/mobile/settings`, { timeout: 20_000 });
      expect(new URL(page.url()).pathname).toBe(`/${prefix}/mobile/settings`);
      await assertNoHorizontalOverflow(page, `Mobile Settings (${vp.name})`);

      // Step 10: Collect console errors and page errors and require zero at test completion
      expect(
        consoleErrors,
        `Expected 0 console errors at ${vp.name}, but found ${consoleErrors.length}:\n${consoleErrors.join('\n')}`,
      ).toHaveLength(0);

      expect(
        pageErrors,
        `Expected 0 page errors at ${vp.name}, but found ${pageErrors.length}:\n${pageErrors.join('\n')}`,
      ).toHaveLength(0);
    });
  });
}
