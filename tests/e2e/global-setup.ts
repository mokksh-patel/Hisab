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
 * LOCAL ONLY:
 * The insert runs through `supabase db query --local`, which talks to the
 * ephemeral stack started by `supabase start`. There is no `--linked`, no
 * `--remote` and no database URL, so this setup cannot reach a hosted project.
 * The command is executed with an argument array (no shell), so no value can be
 * interpreted as a flag or a redirect.
 *
 * Accounts are created ONCE and reused. Each test gets its own business,
 * customer and invoice, so tests remain independent.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { E2E_PASSWORD, type TestAccount } from './fixtures';
import { readE2EConfig } from './env';

export const ACCOUNTS_FILE = resolve(process.cwd(), 'tests/e2e/.accounts.json');

/**
 * Resolves the npm CLI entry point so `npx` can be run without a shell.
 *
 * WHY NOT `execFileSync('npx', ...)`:
 *   * On Windows `npx` is a `.cmd` shim, not an executable, so spawning it
 *     directly fails with ENOENT.
 *   * Node 20+ refuses to spawn `.cmd`/`.bat` files without `shell: true`
 *     (CVE-2024-27980), which fails with EINVAL.
 *   * Using `shell: true` would reintroduce shell-string interpolation, which
 *     is exactly what this setup must avoid.
 *
 * Running `node <npx-cli.js> ...` sidesteps all three: it is a real executable
 * (the current Node binary), it takes an argument array, and no shell is
 * involved on any platform.
 */
function npxCliPath(): string {
  const candidates = [
    // Windows and the official Node installers.
    resolve(dirname(process.execPath), 'node_modules/npm/bin/npx-cli.js'),
    // POSIX layouts (Linux/macOS, including GitHub Actions runners).
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npx-cli.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    'could not locate the npm CLI (npx-cli.js). Ensure npm is installed alongside Node.',
  );
}

export interface E2EAccounts {
  primary: TestAccount;
  secondary: TestAccount;
  resilience: TestAccount;
  /**
   * Dedicated to the onboarding test. It is created fresh on every run and is
   * never used by any other test, so it is guaranteed to have zero businesses
   * when the onboarding test signs in. This is what makes that test repeatable
   * without a conditional skip.
   */
  onboarding: TestAccount;
}

function randomId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function globalSetup(): Promise<void> {
  // Fails closed: throws if the configuration is missing or points anywhere
  // other than loopback. Setup never silently skips.
  readE2EConfig();

  const stamp = randomId();
  const primaryEmail = `e2e+primary-${stamp}@example.com`;
  const secondaryEmail = `e2e+secondary-${stamp}@example.com`;
  const resilienceEmail = `e2e+resilience-${stamp}@example.com`;
  const onboardingEmail = `e2e+onboarding-${stamp}@example.com`;

  // Insert the users with a bcrypt hash of E2E_PASSWORD. `crypt(..., gen_salt('bf'))`
  // produces the same format GoTrue uses, so signInWithPassword works normally.
  //
  // GoTrue requires the token columns to be EMPTY STRINGS, not NULL — a NULL
  // there makes the auth server fail with "Database error querying schema".
  //
  // A dedicated `resilience` account exists so those tests never share business
  // state with the auth/receivables suites. Shared state made results flaky.
  //
  // The emails are generated locally and contain no quotes, so they are safe to
  // inline. E2E_PASSWORD is a fixed test constant, not a secret.
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
      ('${resilienceEmail}', 'E2E Resilience'),
      ('${onboardingEmail}', 'E2E Onboarding')
    ) as u(email, full_name)
    returning id, email;
  `;

  // execFileSync with an argument array: no shell, so the SQL cannot be
  // reinterpreted as a flag or a shell redirect. `--local` is explicit and
  // there is deliberately no `--linked` / `--remote` / `--db-url`.
  //
  // The command is `node <npx-cli.js> ...` rather than `npx ...` so it works
  // identically on Windows and Linux without a shell (see npxCliPath).
  const output = execFileSync(
    process.execPath,
    [npxCliPath(), '--yes', 'supabase', 'db', 'query', '--local', '--output', 'json', sql],
    { stdio: 'pipe', timeout: 180_000, encoding: 'utf8' },
  );

  // Parse the returned rows to get the generated ids.
  const rows = parseRows(output);
  const primary = rows.find((row) => row.email === primaryEmail);
  const secondary = rows.find((row) => row.email === secondaryEmail);
  const resilience = rows.find((row) => row.email === resilienceEmail);
  const onboarding = rows.find((row) => row.email === onboardingEmail);

  if (!primary || !secondary || !resilience || !onboarding) {
    // Do not echo the raw output: it can contain password hashes.
    throw new Error(
      'could not create e2e accounts in the local database. ' +
        'Check that `supabase start` is running and that migrations applied.',
    );
  }

  const accounts: E2EAccounts = {
    primary: { email: primaryEmail, password: E2E_PASSWORD, userId: primary.id },
    secondary: { email: secondaryEmail, password: E2E_PASSWORD, userId: secondary.id },
    resilience: { email: resilienceEmail, password: E2E_PASSWORD, userId: resilience.id },
    onboarding: { email: onboardingEmail, password: E2E_PASSWORD, userId: onboarding.id },
  };

  writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
  console.log(
    `[e2e] created accounts: ${primaryEmail}, ${secondaryEmail}, ${resilienceEmail}, ${onboardingEmail}`,
  );
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
