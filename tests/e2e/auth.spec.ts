/**
 * auth.spec.ts — authentication workflows in a real browser.
 *
 * Covers: signup validation, login, logout, session persistence, password
 * recovery, protected-route redirects and rejected credentials.
 *
 * Accounts are created once by global-setup.ts because Supabase's built-in SMTP
 * enforces a low signup rate limit. Tests that need a signed-in user reuse the
 * shared accounts.
 *
 * Email confirmation is ENABLED on the test project, which is the correct
 * production behaviour. The signup test therefore asserts that a *rejected*
 * signup surfaces a real message rather than a generic failure.
 */

import { expect, test } from '@playwright/test';
import { E2E_PASSWORD, loadAccounts, syntheticEmail } from './fixtures';

test.describe('Authentication', () => {

  test('signup rejects mismatched passwords', async ({ page }) => {
    await page.goto('/signup');

    await page.getByLabel('Full name').fill('E2E Mismatch');
    await page.getByLabel('Email').fill(syntheticEmail('mismatch'));
    await page.getByLabel('Password', { exact: true }).fill(E2E_PASSWORD);
    await page.getByLabel('Confirm password').fill('DifferentPass123!');
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page.getByText('Passwords do not match')).toBeVisible();
  });

  test('signup rejects an invalid email address', async ({ page }) => {
    await page.goto('/signup');

    await page.getByLabel('Full name').fill('E2E Bad Email');
    await page.getByLabel('Email').fill('not-an-email');
    await page.getByLabel('Password', { exact: true }).fill(E2E_PASSWORD);
    await page.getByLabel('Confirm password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page.getByText('Enter a valid email address')).toBeVisible();
  });

  test('signup rejects a short password', async ({ page }) => {
    await page.goto('/signup');

    await page.getByLabel('Full name').fill('E2E Short Pass');
    await page.getByLabel('Email').fill(syntheticEmail('shortpass'));
    await page.getByLabel('Password', { exact: true }).fill('short');
    await page.getByLabel('Confirm password').fill('short');
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page.getByText('Use at least 8 characters')).toBeVisible();
  });

  test('login rejects wrong credentials', async ({ page }) => {
    await page.goto('/login');

    await page.getByLabel('Email').fill(syntheticEmail('wrongpass'));
    await page.getByLabel('Password').fill('DefinitelyWrong123!');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('alert')).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(/\/login/);
  });

  test('protected routes redirect to login when signed out', async ({ page }) => {
    for (const path of ['/', '/invoices', '/customers', '/payments', '/reports', '/settings']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
    }
  });

  test('password recovery shows a neutral confirmation', async ({ page }) => {
    await page.goto('/forgot-password');

    await page.getByLabel('Email').fill(syntheticEmail('recovery'));
    await page.getByRole('button', { name: 'Send reset link' }).click();

    // The same message is shown whether or not the address exists, so the form
    // cannot be used to enumerate registered accounts.
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible({
      timeout: 20_000,
    });
  });

  test('session persists across a page reload', async ({ page }) => {
    const { primary } = loadAccounts();

    await signIn(page, primary.email, primary.password);
    await expect(page).toHaveURL(/\/onboarding|\//, { timeout: 25_000 });

    // Wait for the session to be persisted before asserting on storage.
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Object.keys(window.localStorage).filter((key) => key.includes('auth-token')).length,
          ),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);

    const before = page.url();
    await page.reload();
    await expect(page).toHaveURL(before, { timeout: 25_000 });

    // Still signed in after the reload.
    await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });
  });

  test('logout clears the session and returns to login', async ({ page }) => {
    const { primary } = loadAccounts();

    await signIn(page, primary.email, primary.password);
    await expect(page).toHaveURL(/\/onboarding|\//, { timeout: 25_000 });

    // Sign out via the user menu (dashboard) or the onboarding footer.
    const menuButton = page.getByRole('button', { name: new RegExp(primary.email) });
    if (await menuButton.isVisible().catch(() => false)) {
      await menuButton.click();
      await page.getByRole('menuitem', { name: 'Sign out' }).click();
    } else {
      await page.getByRole('button', { name: /Sign out/ }).click();
    }

    await expect(page).toHaveURL(/\/login/, { timeout: 20_000 });

    // A protected route must bounce back to login.
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });
});

async function signIn(
  page: import('@playwright/test').Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
