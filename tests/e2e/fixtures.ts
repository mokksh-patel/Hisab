/**
 * e2e/fixtures.ts — synthetic accounts and data for browser tests.
 *
 * RULES:
 *  1. Every account uses a unique, clearly synthetic email so test data can
 *     never be confused with a real business.
 *  2. Accounts are created through the real signup API, then confirmed via the
 *     database (email confirmation is enabled on the test project, and there is
 *     no mailbox to read in CI).
 *  3. Cleanup removes everything the test created.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? '';
const PUBLISHABLE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '';

export const E2E_PASSWORD = 'E2eTestPass123!';

/** Unique synthetic email. The `e2e+` prefix makes test rows easy to find. */
export function syntheticEmail(label: string): string {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `e2e+${label}-${stamp}@example.com`;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && PUBLISHABLE_KEY);
}

/** A fresh, unauthenticated client for driving the API directly. */
export function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface TestAccount {
  email: string;
  password: string;
  userId: string;
}

/**
 * Creates a confirmed account via the signup API.
 *
 * Returns the user id. The caller is responsible for confirming the address
 * (see `confirmUser`) before signing in.
 */
export async function createAccount(label: string): Promise<TestAccount> {
  const client = anonClient();
  const email = syntheticEmail(label);

  const { data, error } = await client.auth.signUp({
    email,
    password: E2E_PASSWORD,
    options: { data: { full_name: `E2E ${label}` } },
  });

  if (error) throw new Error(`signup failed for ${email}: ${error.message}`);
  if (!data.user) throw new Error(`signup returned no user for ${email}`);

  return { email, password: E2E_PASSWORD, userId: data.user.id };
}

/** Signs in and returns an authenticated client. */
export async function signInAs(account: TestAccount): Promise<SupabaseClient> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({
    email: account.email,
    password: account.password,
  });
  if (error) throw new Error(`sign-in failed for ${account.email}: ${error.message}`);
  return client;
}

/** Creates a business for the signed-in user and returns its id. */
export async function createBusiness(
  client: SupabaseClient,
  displayName: string,
): Promise<string> {
  const { data, error } = await client.rpc('create_business_with_owner', {
    p_legal_name: `${displayName} Pvt Ltd`,
    p_display_name: displayName,
    p_state_code: '24',
    p_invoice_prefix: 'E2E',
    p_is_gst_registered: true,
  });
  if (error) throw new Error(`create_business failed: ${error.message}`);
  return data as string;
}

/** Creates a customer and returns its id. */
export async function createCustomer(
  client: SupabaseClient,
  businessId: string,
  name: string,
  phone?: string,
): Promise<string> {
  const { data, error } = await client
    .from('customers')
    .insert({
      business_id: businessId,
      customer_name: name,
      phone: phone ?? null,
      state_code: '24',
    })
    .select('id')
    .single();
  if (error) throw new Error(`create_customer failed: ${error.message}`);
  return (data as { id: string }).id;
}

/** Creates a draft invoice and returns its id. */
export async function createInvoice(
  client: SupabaseClient,
  businessId: string,
  customerId: string,
  options: { quantity?: string; unitPricePaise?: string; dueDate?: string } = {},
): Promise<string> {
  const { data, error } = await client.rpc('create_invoice', {
    p_business_id: businessId,
    p_customer_id: customerId,
    p_invoice_date: '2026-10-01',
    p_due_date: options.dueDate ?? '2026-10-31',
    p_gst_mode: 'intra_state',
    p_place_of_supply_state_code: '24',
    p_lines: [
      {
        description: 'E2E test item',
        quantity: options.quantity ?? '10',
        unit_price_paise: options.unitPricePaise ?? '50000',
        tax_rate_basis_points: 1800,
        discount_percent_basis_points: 0,
        cess_rate_basis_points: 0,
      },
    ],
  });
  if (error) throw new Error(`create_invoice failed: ${error.message}`);
  return data as string;
}

/** Issues a draft invoice. */
export async function issueInvoice(client: SupabaseClient, invoiceId: string): Promise<void> {
  const { error } = await client.rpc('issue_invoice', { p_invoice_id: invoiceId });
  if (error) throw new Error(`issue_invoice failed: ${error.message}`);
}

/** Records a payment, optionally allocated to one invoice. */
export async function recordPayment(
  client: SupabaseClient,
  businessId: string,
  customerId: string,
  amountPaise: string,
  invoiceId?: string,
): Promise<string> {
  const { data, error } = await client.rpc('record_payment', {
    p_business_id: businessId,
    p_customer_id: customerId,
    p_payment_date: '2026-10-15',
    p_amount_paise: amountPaise,
    p_payment_method: 'upi',
    p_reference_number: 'E2E-REF',
    p_idempotency_key: `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    p_allocations: invoiceId
      ? [{ invoice_id: invoiceId, amount_paise: amountPaise }]
      : [],
  });
  if (error) throw new Error(`record_payment failed: ${error.message}`);
  return data as string;
}

// ---------------------------------------------------------------------------
// Shared accounts created once by global-setup.ts
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface E2EAccounts {
  primary: TestAccount;
  secondary: TestAccount;
  resilience: TestAccount;
}

/** Loads the accounts created by global-setup. Throws if setup did not run. */
export function loadAccounts(): E2EAccounts {
  const file = resolve(process.cwd(), 'tests/e2e/.accounts.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as E2EAccounts;
  } catch {
    throw new Error(
      'e2e accounts not found. global-setup should have created them — check that Supabase is configured.',
    );
  }
}
