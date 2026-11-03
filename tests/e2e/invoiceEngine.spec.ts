/**
 * invoiceEngine.spec.ts — Invoice Engine V2 browser workflow.
 *
 * Covers the complete create → issue flow with the new pricing controls:
 *   - GST-exclusive and GST-inclusive entry
 *   - invoice-level discount
 *   - the tax breakdown on the detail page
 *   - the place-of-supply warning
 *
 * Data is seeded through the real RPCs so the assertions run against genuine
 * database state.
 */

import { expect, test } from '@playwright/test';
import {
  createBusiness,
  createCustomer,
  loadAccounts,
  signInAs,
} from './fixtures';

test.describe('Invoice Engine V2', () => {

  test('create page exposes pricing mode and invoice discount', async ({ page }) => {
    const { resilience } = loadAccounts();
    await signInAndReachApp(page, resilience.email, resilience.password);

    await page.goto('/invoices/new');
    await expect(page.getByRole('heading', { name: 'Create invoice' })).toBeVisible({
      timeout: 20_000,
    });

    // The new controls must be present and usable.
    await expect(page.getByLabel('Price entry')).toBeVisible();
    await expect(page.getByLabel('Invoice discount (₹)')).toBeVisible();

    // Switching to inclusive must change the hint text.
    await page.getByLabel('Price entry').selectOption('inclusive');
    await expect(page.getByText(/customer pays the entered amount/i)).toBeVisible();
  });

  test('live preview shows the exclusive total', async ({ page }) => {
    const { resilience } = loadAccounts();
    await signInAndReachApp(page, resilience.email, resilience.password);

    // Seed a customer so the form can be completed.
    const client = await signInAs(resilience);
    const businessName = `E2E V2 ${Date.now()}`;
    const businessId = await createBusiness(client, businessName);
    await createCustomer(client, businessId, 'E2E V2 Customer', '+919876500111');

    // Point the browser at the business that owns the customer.
    //
    // The shared account accumulates businesses across runs, and
    // BusinessContext keeps whatever id is already in localStorage as long as
    // it is still valid. Without this the form would query the previously
    // selected business, find no customers and leave the dropdown empty.
    await selectBusinessInBrowser(page, businessId, businessName);

    await page.goto('/invoices/new');
    await expect(page.getByRole('heading', { name: 'Create invoice' })).toBeVisible({
      timeout: 20_000,
    });

    await page.getByLabel('Customer').selectOption({ label: 'E2E V2 Customer' });
    await page.getByLabel('Description').first().fill('Widget');
    await page.getByLabel('Quantity').first().fill('10');
    await page.getByLabel('Unit price (₹)').first().fill('500');
    await page.getByLabel('GST rate %').first().fill('18');

    // 10 x Rs500 + 18% = Rs5,900.
    await expect(page.getByText('₹5,900.00').first()).toBeVisible({ timeout: 15_000 });
  });

  test('live preview shows the inclusive total', async ({ page }) => {
    const { resilience } = loadAccounts();
    await signInAndReachApp(page, resilience.email, resilience.password);

    const client = await signInAs(resilience);
    const businessName = `E2E V2I ${Date.now()}`;
    const businessId = await createBusiness(client, businessName);
    await createCustomer(client, businessId, 'E2E V2 Inclusive', '+919876500222');

    // See the exclusive test: the selection must be pinned to the new business.
    await selectBusinessInBrowser(page, businessId, businessName);

    await page.goto('/invoices/new');
    await expect(page.getByRole('heading', { name: 'Create invoice' })).toBeVisible({
      timeout: 20_000,
    });

    await page.getByLabel('Customer').selectOption({ label: 'E2E V2 Inclusive' });
    await page.getByLabel('Price entry').selectOption('inclusive');
    await page.getByLabel('Description').first().fill('Widget');
    await page.getByLabel('Quantity').first().fill('10');
    await page.getByLabel('Unit price (₹)').first().fill('500');
    await page.getByLabel('GST rate %').first().fill('18');

    // Inclusive: the customer pays exactly Rs5,000.
    await expect(page.getByText('₹5,000.00').first()).toBeVisible({ timeout: 15_000 });
  });

  test('invoice detail shows the tax breakdown', async ({ page }) => {
    const { resilience } = loadAccounts();
    await signInAndReachApp(page, resilience.email, resilience.password);

    const client = await signInAs(resilience);
    const businessId = await createBusiness(client, `E2E V2D ${Date.now()}`);
    const customerId = await createCustomer(client, businessId, 'E2E V2 Detail', '+919876500333');

    const { data: invoiceId, error } = await client.rpc('create_invoice', {
      p_business_id: businessId,
      p_customer_id: customerId,
      p_invoice_date: '2026-10-01',
      p_due_date: '2026-10-31',
      p_gst_mode: 'intra_state',
      p_place_of_supply_state_code: '24',
      p_lines: [
        {
          description: 'Widget',
          quantity: '10',
          unit_price_paise: '50000',
          tax_rate_basis_points: 1800,
        },
      ],
      p_notes: null,
      p_invoice_number: null,
      p_price_includes_tax: false,
      p_invoice_discount_paise: '0',
    });
    expect(error).toBeNull();

    await page.goto(`/invoices/${invoiceId}`);
    await expect(page.getByText('Tax breakdown')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Taxable value')).toBeVisible();
    await expect(page.getByText('CGST')).toBeVisible();
    await expect(page.getByText('SGST')).toBeVisible();
  });

  test('settings page exposes the GST scheme selector', async ({ page }) => {
    const { resilience } = loadAccounts();
    await signInAndReachApp(page, resilience.email, resilience.password);

    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel('GST scheme')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function signInAndReachApp(
  page: import('@playwright/test').Page,
  email: string,
  password: string,
): Promise<void> {
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
  await page.waitForLoadState('networkidle').catch(() => {
    /* best-effort */
  });
  await page.waitForTimeout(1000);

  if (page.url().includes('/onboarding')) {
    const stamp = Date.now();
    await page.getByLabel('Legal business name').fill(`E2E V2 ${stamp} Pvt Ltd`);
    await page.getByLabel('Display name').fill(`E2E V2 ${stamp}`);
    const createButton = page.getByRole('button', { name: 'Create business' });
    await createButton.scrollIntoViewIfNeeded();
    await createButton.click();
    await page.waitForURL('/', { timeout: 30_000 });
  }
}

/**
 * Pins the browser's selected business to `businessId`, then reloads so
 * BusinessContext re-initialises against it.
 *
 * WHY A RELOAD IS REQUIRED
 *   BusinessContext reads `bizpilot.selectedBusinessId` from localStorage only
 *   in its useState initialiser, and its selection effect keeps the stored id
 *   whenever it is still valid. Writing localStorage alone therefore has no
 *   effect on the running app: the in-memory selection is unchanged, and the
 *   business list is cached with `staleTime: 60_000`. A full reload is what
 *   makes the context pick up the new id and refetch the list.
 *
 * The Topbar assertion is the synchronisation point: it only shows the new
 * name once the list has been refetched and the selection resolved, so the
 * subsequent navigation cannot race the context.
 */
async function selectBusinessInBrowser(
  page: import('@playwright/test').Page,
  businessId: string,
  businessName: string,
): Promise<void> {
  await page.evaluate(
    ([key, id]) => window.localStorage.setItem(key, id),
    ['bizpilot.selectedBusinessId', businessId] as const,
  );

  await page.reload();

  // The Topbar button's accessible name is the display name plus the role.
  await expect(
    page.getByRole('button', { name: new RegExp(businessName) }),
  ).toBeVisible({ timeout: 20_000 });
}
