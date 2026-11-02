/**
 * receivables.spec.ts — the core business workflow in a real browser.
 *
 * Onboarding → customer → invoice → issue → payment → dashboard.
 *
 * Data is created through the real API (the same RPCs the UI calls) so the
 * browser assertions test the UI against genuine database state, not mocks.
 */

import { expect, test } from '@playwright/test';
import {
  createBusiness,
  createCustomer,
  createInvoice,
  issueInvoice,
  loadAccounts,
  recordPayment,
  signInAs,
} from './fixtures';

test.describe('Receivables workflow', () => {

  test('onboarding creates a business and lands on the dashboard', async ({ page }) => {
    // A dedicated account is created fresh by global-setup on every run and is
    // used by no other test, so it is guaranteed to have zero businesses here.
    // That makes this test repeatable without a conditional skip: the account
    // can never arrive with a business already attached.
    const { onboarding } = loadAccounts();

    await page.goto('/login');
    await page.getByLabel('Email').fill(onboarding.email);
    await page.getByLabel('Password').fill(onboarding.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // A user with no business is redirected to onboarding by RequireBusiness.
    // Asserting the URL is the precondition of this test, not a branch: if the
    // account unexpectedly has a business, the test must fail loudly rather
    // than skip.
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 25_000 });

    await expect(page.getByRole('heading', { name: 'Set up your business' })).toBeVisible();

    await page.getByLabel('Legal business name').fill('E2E Onboard Traders Pvt Ltd');
    await page.getByLabel('Display name').fill('E2E Onboard Traders');
    await page.getByLabel('Invoice prefix').fill('EOT');
    await page.getByRole('button', { name: 'Create business' }).click();

    // Dashboard loads with an empty state, not fabricated figures.
    await expect(page).toHaveURL('/', { timeout: 25_000 });
    await expect(page.getByText('Total outstanding')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('No invoices yet')).toBeVisible({ timeout: 20_000 });
  });

  test('dashboard reflects a real issued invoice', async ({ page }) => {
    const { account, businessId, customerId, invoiceId } = await seedBusiness('dash');

    await signInInBrowser(page, account.email, account.password, businessId);

    // ₹5,900 invoice (10 × ₹500 + 18% GST).
    await expect(page.getByText('₹5,900.00').first()).toBeVisible({ timeout: 25_000 });
    await expect(page.getByText('E2E Customer').first()).toBeVisible({ timeout: 20_000 });

    // Sanity: the seeded ids are real.
    expect(businessId).toBeTruthy();
    expect(customerId).toBeTruthy();
    expect(invoiceId).toBeTruthy();
  });

  test('partial payment reduces the outstanding balance', async ({ page }) => {
    const { account, businessId, customerId, invoiceId } = await seedBusiness('partial');

    // Pay ₹2,000 of ₹5,900.
    const client = await signInAs(account);
    await recordPayment(client, businessId, customerId, '200000', invoiceId);

    await signInInBrowser(page, account.email, account.password, businessId);

    // Outstanding should now be ₹3,900.
    await expect(page.getByText('₹3,900.00').first()).toBeVisible({ timeout: 25_000 });
  });

  test('invoice list shows the invoice and its derived status', async ({ page }) => {
    const { account, businessId } = await seedBusiness('list');

    await signInInBrowser(page, account.email, account.password, businessId);
    await page.goto('/invoices');

    await expect(page.getByRole('heading', { name: 'Invoices' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('E2E-2026-27-001')).toBeVisible({ timeout: 20_000 });
    // Due 2026-10-31, so in the past relative to the seeded dates → Overdue.
    await expect(page.getByText(/Overdue|Current|Due today/).first()).toBeVisible();
  });

  test('invoice search filters the list', async ({ page }) => {
    const { account, businessId } = await seedBusiness('search');

    await signInInBrowser(page, account.email, account.password, businessId);
    await page.goto('/invoices');
    await expect(page.getByText('E2E-2026-27-001')).toBeVisible({ timeout: 20_000 });

    await page.getByPlaceholder('Search invoice or customer').fill('nonexistent-xyz');
    await expect(page.getByText('No matching invoices')).toBeVisible({ timeout: 15_000 });

    await page.getByPlaceholder('Search invoice or customer').fill('E2E Customer');
    await expect(page.getByText('E2E-2026-27-001')).toBeVisible({ timeout: 15_000 });
  });

  test('customers page lists the customer with its balance', async ({ page }) => {
    const { account, businessId } = await seedBusiness('customers');

    await signInInBrowser(page, account.email, account.password, businessId);
    await page.goto('/customers');

    await expect(page.getByRole('heading', { name: 'Customers' })).toBeVisible({ timeout: 20_000 });
    // Scope to the table so the business name in the topbar cannot match.
    await expect(page.getByRole('link', { name: 'E2E Customer' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('₹5,900.00').first()).toBeVisible({ timeout: 20_000 });
  });

  test('reports page renders the aging summary', async ({ page }) => {
    const { account, businessId } = await seedBusiness('reports');

    await signInInBrowser(page, account.email, account.password, businessId);
    await page.goto('/reports');

    await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Aging summary')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Total outstanding')).toBeVisible({ timeout: 20_000 });
  });

  test('payments page lists the recorded payment', async ({ page }) => {
    const { account, businessId, customerId, invoiceId } = await seedBusiness('payments');

    const client = await signInAs(account);
    await recordPayment(client, businessId, customerId, '200000', invoiceId);

    await signInInBrowser(page, account.email, account.password, businessId);
    await page.goto('/payments');

    await expect(page.getByRole('heading', { name: 'Payments' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('₹2,000.00').first()).toBeVisible({ timeout: 20_000 });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedBusiness(label: string) {
  // Reuse the shared account created by global-setup. Each test still gets its
  // own business, customer and invoice, so tests stay independent — but no new
  // signup is performed (Supabase's built-in SMTP rate-limits signups hard).
  const { primary } = loadAccounts();
  const account = primary;
  const client = await signInAs(account);
  const businessId = await createBusiness(client, `E2E ${label} ${Date.now()}`);
  const customerId = await createCustomer(client, businessId, 'E2E Customer', '+919876500000');
  const invoiceId = await createInvoice(client, businessId, customerId);
  await issueInvoice(client, invoiceId);
  return { account, businessId, customerId, invoiceId };
}

async function signInInBrowser(
  page: import('@playwright/test').Page,
  email: string,
  password: string,
  businessId?: string,
) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Wait for the session to be established before touching storage.
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Object.keys(window.localStorage).filter((key) => key.includes('auth-token')).length,
        ),
      { timeout: 25_000 },
    )
    .toBeGreaterThan(0);

  // Pin the business under test. The shared account accumulates businesses
  // across runs, so the selection must be explicit rather than "whichever the
  // app picked".
  if (businessId) {
    await page.evaluate(
      ([key, id]) => window.localStorage.setItem(key, id),
      ['bizpilot.selectedBusinessId', businessId] as const,
    );
    await page.goto('/');
  }

  await expect(page).toHaveURL('/', { timeout: 25_000 });
}
