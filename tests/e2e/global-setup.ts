/**
 * global-setup.ts — creates the synthetic accounts the e2e suite needs.
 *
 * WHY NOT THE SIGNUP API:
 * Supabase's built-in SMTP enforces a low signup rate limit (a handful per
 * hour). Driving signup through the API exhausts it immediately and makes the
 * suite non-repeatable. Accounts are therefore inserted directly into
 * `auth.users` with a bcrypt-hashed password, which is exactly what GoTrue
 * stores. Sign-in still goes through the real auth API, so the login path is
 * genuinely exercised.
 *
 * The signup *form* is still tested — see auth.spec.ts, which asserts client-side
 * validation and the server's rejection messages.
 *
 * Accounts are created ONCE and reused. Each test gets its own business,
 * customer and invoice, so tests remain independent.
 */

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { E2E_PASSWORD, isSupabaseConfigured, type TestAccount } from './fixtures';

export const ACCOUNTS_FILE = resolve(process.cwd(), 'tests/e2e/.accounts.json');

export interface E2EAccounts {
  primary: TestAccount;
  secondary: TestAccount;
  resilience: TestAccount;
}

function randomId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function globalSetup(): Promise<void> {
  if (!isSupabaseConfigured()) {
    console.warn('[e2e] Supabase not configured — tests will skip.');
    return;
  }

  const stamp = randomId();
  const primaryEmail = `e2e+primary-${stamp}@example.com`;
  const secondaryEmail = `e2e+secondary-${stamp}@example.com`;
  const resilienceEmail = `e2e+resilience-${stamp}@example.com`;

  // Insert the users with a bcrypt hash of E2E_PASSWORD. `crypt(..., gen_salt('bf'))`
  // produces the same format GoTrue uses, so signInWithPassword works normally.
  //
  // GoTrue requires the token columns to be EMPTY STRINGS, not NULL — a NULL
  // there makes the auth server fail with "Database error querying schema".
  //
  // A dedicated `resilience` account exists so those tests never share business
  // state with the auth/receivables suites. Shared state made results flaky.
  const sql = `
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous,
      confirmation_token, recovery_token, email_change, email_change_token_new,
      email_change_token_current, phone_change, phone_change_token, reauthentication_token
    )
    select
      '00000000-0000-0000-0000-000000000000'::uuid,
      gen_random_uuid(),
      'authenticated',
      'authenticated',
      u.email,
      crypt('${E2E_PASSWORD}', gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('full_name', u.full_name),
      false, false,
      '', '', '', '', '', '', '', ''
    from (values
      ('${primaryEmail}', 'E2E Primary'),
      ('${secondaryEmail}', 'E2E Secondary'),
      ('${resilienceEmail}', 'E2E Resilience')
    ) as u(email, full_name)
    returning id, email;
  `;

  const output = execSync(
    `npx --yes supabase db query --linked --output json "${sql.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
    { stdio: 'pipe', timeout: 180_000, encoding: 'utf8' },
  );

  // Parse the returned rows to get the generated ids.
  const rows = parseRows(output);
  const primary = rows.find((row) => row.email === primaryEmail);
  const secondary = rows.find((row) => row.email === secondaryEmail);
  const resilience = rows.find((row) => row.email === resilienceEmail);

  if (!primary || !secondary || !resilience) {
    throw new Error(`could not create e2e accounts. Output: ${output}`);
  }

  const accounts: E2EAccounts = {
    primary: { email: primaryEmail, password: E2E_PASSWORD, userId: primary.id },
    secondary: { email: secondaryEmail, password: E2E_PASSWORD, userId: secondary.id },
    resilience: { email: resilienceEmail, password: E2E_PASSWORD, userId: resilience.id },
  };

  writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
  console.log(`[e2e] created accounts: ${primaryEmail}, ${secondaryEmail}, ${resilienceEmail}`);
}

function parseRows(output: string): { id: string; email: string }[] {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try {
    return JSON.parse(output.slice(start, end + 1)) as { id: string; email: string }[];
  } catch {
    return [];
  }
}

export default globalSetup;
