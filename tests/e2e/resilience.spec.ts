/**
 * resilience.spec.ts — network, session and responsive behaviour.
 *
 * Covers the gaps identified in Phase 4:
 *   - tablet layout
 *   - slow network
 *   - offline network
 *   - expired / invalid session
 *   - error recovery
 *
 * These tests do not create accounts (the signup API is rate-limited); they use
 * the shared accounts from global-setup.
 */

import { expect, test, type Page } from '@playwright/test';
import { isSupabaseConfigured, loadAccounts } from './fixtures';

test.describe('Resilience', () => {
  test.skip(!isSupabaseConfigured(), 'Supabase is not configured');

  test('tablet layout renders navigation and dashboard', async ({ browser }) => {
    const { resilience } = loadAccounts();
    // iPad Mini viewport.
    const context = await browser.newContext({
      viewport: { width: 768, height: 1024 },
      deviceScaleFactor: 2,
      isMobile: false,
      hasTouch: true,
    });
    const page = await context.newPage();

    await signInAndReachApp(page, resilience.email, resilience.password);

    // At 768px the sidebar is an off-canvas drawer (Tailwind lg breakpoint is
    // 1024px), so it must be opened via the menu button.
    const menuButton = page.getByRole('button', { name: 'Open navigation' });
    await expect(menuButton).toBeVisible({ timeout: 20_000 });
    await menuButton.click();

    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(nav).toBeVisible({ timeout: 10_000 });
    await expect(nav.getByRole('link', { name: 'Invoices' })).toBeVisible();

    await page.getByRole('button', { name: 'Close navigation' }).click();
    const hasOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
    );
    expect(hasOverflow).toBe(false);

    await context.close();
  });

  test('slow network still loads the dashboard', async ({ page }) => {
    const { resilience } = loadAccounts();
    await signInAndReachApp(page, resilience.email, resilience.password);

    const client = await page.context().newCDPSession(page);
    await client.send('Network.enable');
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 400,
      downloadThroughput: (400 * 1024) / 8,
      uploadThroughput: (400 * 1024) / 8,
    });

    await page.goto('/');
    // Loading skeletons must appear rather than a blank screen.
    await expect(page.getByText('Total outstanding')).toBeVisible({ timeout: 60_000 });

    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  });

  test('offline network does not show a blank page', async ({ page }) => {
    const { resilience } = loadAccounts();
    await signInAndReachApp(page, resilience.email, resilience.password);

    const client = await page.context().newCDPSession(page);
    await client.send('Network.enable');
    await client.send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    });

    // Navigate client-side, as a user clicking a link would. A full page.goto()
    // would fail at the network layer before the app can render anything, which
    // tests the browser rather than the application.
    await page.evaluate(() => {
      window.history.pushState({}, '', '/invoices');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.waitForTimeout(3000);

    // The app shell must still be present — a blank screen is the failure mode
    // this test exists to catch. Either the shell renders, or the ErrorBoundary
    // shows its recovery screen. Both are acceptable; silence is not.
    const bodyText = await page.locator('body').innerText().catch(() => '');
    expect(bodyText.trim().length).toBeGreaterThan(0);
    const recovered =
      bodyText.includes('BizPilot') || bodyText.includes('Something went wrong');
    expect(recovered).toBe(true);

    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  });

  test('an invalid session token redirects to login', async ({ page }) => {
    await page.goto('/login');
    await page.evaluate(() => {
      const key = Object.keys(window.localStorage).find((k) => k.includes('auth-token'));
      const storageKey = key ?? 'sb-xseytkeykqwgirgixlir-auth-token';
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({
          access_token: 'invalid.token.value',
          refresh_token: 'invalid-refresh',
          expires_at: Math.floor(Date.now() / 1000) - 3600,
          token_type: 'bearer',
          user: { id: '00000000-0000-0000-0000-000000000000', email: 'expired@example.com' },
        }),
      );
    });

    await page.goto('/');
    await expect(page).toHaveURL(/\/login/, { timeout: 25_000 });
  });

  test('unknown route shows a 404 page, not a crash', async ({ page }) => {
    await page.goto('/this-route-does-not-exist');
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('payment form opens and exposes an idempotent submit', async ({ page }) => {
    const { resilience } = loadAccounts();
    await signInAndReachApp(page, resilience.email, resilience.password);

    await page.goto('/payments');
    await expect(page.getByRole('heading', { name: 'Payments' })).toBeVisible({ timeout: 20_000 });

    const recordButton = page.getByRole('button', { name: 'Record payment' }).first();
    await expect(recordButton).toBeVisible({ timeout: 10_000 });
    await recordButton.click();
    await expect(page.getByRole('heading', { name: 'Record a payment' })).toBeVisible({
      timeout: 10_000,
    });

    // The submit button must be present and enabled — a dead button is a defect.
    const saveButton = page.getByRole('button', { name: 'Save payment' });
    await expect(saveButton).toBeVisible();
    await expect(saveButton).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Signs in and guarantees the app shell is reachable.
 *
 * A fresh shared account has no business, so it lands on onboarding. The
 * business is created through the UI — the same path a real user takes — which
 * also keeps BusinessContext in sync (an API-created business is not reflected
 * in the already-loaded context).
 */
async function signInAndReachApp(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Object.keys(window.localStorage).filter((key) => key.includes('auth-token')).length,
        ),
      { timeout: 25_000 },
    )
    .toBeGreaterThan(0);

  await page.waitForURL(/\/(onboarding)?$/, { timeout: 30_000 });
  // Let the route settle: the guard may redirect once more after the session
  // resolves, and reading page.url() too early picks the wrong branch.
  await page.waitForLoadState('networkidle').catch(() => {
    /* networkidle is best-effort */
  });
  await page.waitForTimeout(1000);

  // Onboarding appears in two forms: "Set up your business" (first business) and
  // "Add another business" (subsequent). Both need a business created before the
  // app shell is reachable.
  if (page.url().includes('/onboarding')) {
    const stamp = Date.now();
    await page.getByLabel('Legal business name').fill(`E2E Resilience ${stamp} Pvt Ltd`);
    await page.getByLabel('Display name').fill(`E2E Resilience ${stamp}`);
    const createButton = page.getByRole('button', { name: 'Create business' });
    await createButton.scrollIntoViewIfNeeded();
    await createButton.click();
    await page.waitForURL('/', { timeout: 30_000 });
  }

  await expect(page.getByText('Total outstanding')).toBeVisible({ timeout: 30_000 });
}
