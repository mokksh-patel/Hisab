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

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { E2E_PASSWORD, type TestAccount } from './fixtures';
import { readE2EConfig } from './env';
import { buildFailureDiagnostic } from './diagnostics';
import { parseQueryRows } from './cli-output';
import { buildSeedSql } from './seed-sql';
import {
  PGCRYPTO_SCHEMA_QUERY,
  buildPasswordHashExpression,
  parsePgcryptoSchema,
} from './pgcrypto';

export const ACCOUNTS_FILE = resolve(process.cwd(), 'tests/e2e/.accounts.json');

/**
 * The Supabase CLI version this setup is written against.
 *
 * Re-exported from cli-version.ts, which is free of Node built-ins so the
 * unit-test project can import it. MUST match `SUPABASE_CLI_VERSION` in
 * .github/workflows/bizpilot-ci.yml.
 */
export { PINNED_SUPABASE_CLI_VERSION } from './cli-version';

/**
 * Resolves the Supabase CLI to execute, WITHOUT a shell.
 *
 * WHY NOT `npx --yes supabase`:
 *   `npx --yes supabase` resolves `supabase` from the npm registry, not from
 *   PATH. It therefore ignores the binary that `supabase/setup-cli@v3`
 *   installed in CI and downloads whatever `latest` happens to be — which is
 *   now CLI 3.x, a major version that rejects this project's `[inbucket]`
 *   config section outright. The version that ran was neither pinned nor
 *   knowable from the workflow file.
 *
 * Resolution order:
 *   1. `SUPABASE_CLI_PATH` — an explicit override, used by the workflow to
 *      point at the setup-cli binary. Validated to exist.
 *   2. The locally installed npm package, `node_modules/supabase/dist/supabase.js`,
 *      run with the current Node binary. This is a real file on every platform,
 *      so it needs no `.cmd` shim and no shell (see the note below).
 *   3. `supabase` on PATH, spawned directly. On Windows this is a `.cmd` shim,
 *      which Node 20+ refuses to spawn without `shell: true` (CVE-2024-27980),
 *      so this branch is only taken on POSIX.
 *
 * Every candidate is a real executable plus an argument array. `shell` is
 * always false, so no value can be reinterpreted as a flag or a redirect.
 */
interface CliCommand {
  /** Executable to spawn. */
  file: string;
  /** Arguments that precede the Supabase subcommand. */
  prefixArgs: string[];
  /** Human-readable description for diagnostics. */
  description: string;
}

function resolveSupabaseCli(): CliCommand {
  const override = (process.env.SUPABASE_CLI_PATH ?? '').trim();
  if (override) {
    if (!existsSync(override)) {
      throw new Error(
        'SUPABASE_CLI_PATH is set but does not point at an existing file. ' +
          'Refusing to fall back to an unpinned CLI.',
      );
    }
    return { file: override, prefixArgs: [], description: override };
  }

  // The npm package ships a Node entry point, so it runs under the current
  // Node binary on Windows and Linux alike — no shim, no shell.
  const npmEntry = resolve(process.cwd(), 'node_modules/supabase/dist/supabase.js');
  if (existsSync(npmEntry)) {
    return {
      file: process.execPath,
      prefixArgs: [npmEntry],
      description: `node ${npmEntry}`,
    };
  }

  // POSIX only: a bare `supabase` on PATH is a real executable there.
  if (process.platform !== 'win32') {
    return { file: 'supabase', prefixArgs: [], description: 'supabase (PATH)' };
  }

  throw new Error(
    'could not locate the Supabase CLI. Install the pinned version with ' +
      `\`npm install --no-save supabase@${PINNED_SUPABASE_CLI_VERSION}\`, or set ` +
      'SUPABASE_CLI_PATH to the binary installed by supabase/setup-cli.',
  );
}

/**
 * Reads the version of the resolved CLI.
 *
 * Reported in the failure diagnostic so a version mismatch is visible in the
 * CI log instead of having to be inferred.
 */
function readCliVersion(cli: CliCommand): string {
  const result = spawnSync(cli.file, [...cli.prefixArgs, '--version'], {
    shell: false,
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const version = (result.stdout ?? '').trim();
  if (result.status === 0 && version) return version;
  return 'unknown';
}

export interface E2EAccounts {
  primary: TestAccount;
  secondary: TestAccount;
  resilience: TestAccount;
  /**
   * Dedicated to the onboarding test, one account PER PROJECT. Both are created
   * fresh on every run and are used by no other test, so each is guaranteed to
   * have zero businesses when the onboarding test signs in.
   *
   * WHY ONE PER PROJECT: the desktop and mobile projects share this accounts
   * file, and the onboarding test creates a business. A single shared account
   * meant the second project to run found a business already attached and the
   * app correctly rendered "Add another business" instead of "Set up your
   * business". Separate accounts keep the test repeatable in both projects
   * without a conditional skip.
   */
  onboardingDesktop: TestAccount;
  onboardingMobile: TestAccount;
}

function randomId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Runs `supabase db query --local` and returns its stdout.
 *
 * Uses spawnSync (not execFileSync) so a non-zero exit does not throw away
 * stderr: the Postgres error message is the whole point of the diagnostic.
 * The command is an executable plus an argument array with no shell, so
 * nothing can be reinterpreted as a flag or a shell redirect.
 *
 * ARGUMENT ORDER (verified against CLI 2.122.1):
 *
 *   <cli> --agent yes db query --local --output json <sql>
 *
 * `--agent yes` is a GLOBAL Supabase flag, so it must precede the `db`
 * subcommand. It is not the `--yes` confirmation flag and must not be confused
 * with it: `--yes` answers prompts, `--agent yes` selects machine-readable
 * output. Agent mode is what makes the CLI emit the `{ rows: [...] }` envelope
 * deterministically instead of relying on automatic agent detection, which
 * behaves differently under GitHub Actions.
 *
 * `--local` is explicit and there is deliberately no `--linked`, `--remote` or
 * `--db-url`, so the command cannot reach a hosted project.
 */
function runLocalQuery(cli: CliCommand, cliVersion: string, sql: string): string {
  const args = [
    ...cli.prefixArgs,
    '--agent',
    'yes',
    'db',
    'query',
    '--local',
    '--output',
    'json',
    sql,
  ];

  const result = spawnSync(cli.file, args, {
    // No shell: the SQL is passed as a single argv element.
    shell: false,
    encoding: 'utf8',
    timeout: 180_000,
    // Capture both streams; never inherit (which would print the SQL).
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';

  if (result.error) {
    // Spawn-level failure (ENOENT, timeout, EINVAL...). The message is safe:
    // it describes the process, not the SQL.
    const reason =
      (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
        ? 'the command timed out after 180s'
        : result.error.message;
    throw new Error(
      `[e2e] could not run the local Supabase CLI (${cli.description}): ${reason}. ` +
        'Check that `supabase start` is running and that the CLI is installed.',
    );
  }

  if (result.status !== 0) {
    // Both streams are reported independently and redacted. The SQL statement
    // itself is never printed.
    throw new Error(
      buildFailureDiagnostic({
        cliVersion,
        status: result.status,
        signal: result.signal,
        stdout,
        stderr,
      }),
    );
  }

  return stdout;
}

async function globalSetup(): Promise<void> {
  // Fails closed: throws if the configuration is missing or points anywhere
  // other than loopback. Setup never silently skips.
  readE2EConfig();

  // Resolve the CLI once, and record which version actually runs. The version
  // is reported in any failure diagnostic so a mismatch with the workflow's
  // pinned version is visible rather than inferred.
  const cli = resolveSupabaseCli();
  const cliVersion = readCliVersion(cli);

  const stamp = randomId();
  const primaryEmail = `e2e+primary-${stamp}@example.com`;
  const secondaryEmail = `e2e+secondary-${stamp}@example.com`;
  const resilienceEmail = `e2e+resilience-${stamp}@example.com`;
  const onboardingDesktopEmail = `e2e+onboarding-desktop-${stamp}@example.com`;
  const onboardingMobileEmail = `e2e+onboarding-mobile-${stamp}@example.com`;

  // Discover where pgcrypto actually lives before building the seed statement.
  //
  // The extension schema is NOT guaranteed to be `public` or `extensions`; it
  // depends on how the database was provisioned. Hard-coding either name
  // produced `function extensions.crypt(unknown, unknown) does not exist`
  // (SQLSTATE 42883) on the real local stack. The catalog is the only
  // authoritative source, so it is queried through the same local-only helper.
  const pgcryptoSchema = parsePgcryptoSchema(
    runLocalQuery(cli, cliVersion, PGCRYPTO_SCHEMA_QUERY),
  );

  // Both crypt() and gen_salt() are pgcrypto functions, so both are qualified
  // with the discovered schema. The schema name is validated as a PostgreSQL
  // identifier before it reaches the SQL (see pgcrypto.ts).
  const passwordHash = buildPasswordHashExpression(pgcryptoSchema, E2E_PASSWORD);

  // Insert the users with a bcrypt hash of E2E_PASSWORD. The expression
  // produces the same format GoTrue stores, so signInWithPassword works
  // normally.
  //
  // GoTrue requires the token columns to be EMPTY STRINGS, not NULL — a NULL
  // there makes the auth server fail with "Database error querying schema".
  //
  // A dedicated `resilience` account exists so those tests never share business
  // state with the auth/receivables suites. Shared state made results flaky.
  //
  // The statement also writes the matching `auth.identities` row for each user.
  // A user row alone is NOT a usable account: GoTrue resolves a sign-in through
  // the provider identity, so without an `email` identity signInWithPassword
  // fails even though the user exists, is confirmed and has the right hash.
  // Both writes happen in one statement (see seed-sql.ts).
  const sql = buildSeedSql(
    [
      { email: primaryEmail, fullName: 'E2E Primary' },
      { email: secondaryEmail, fullName: 'E2E Secondary' },
      { email: resilienceEmail, fullName: 'E2E Resilience' },
      { email: onboardingDesktopEmail, fullName: 'E2E Onboarding Desktop' },
      { email: onboardingMobileEmail, fullName: 'E2E Onboarding Mobile' },
    ],
    passwordHash,
  );

  // Runs `supabase db query --local` with no shell. `--local` is explicit and
  // there is deliberately no `--linked` / `--remote` / `--db-url`.
  const output = runLocalQuery(cli, cliVersion, sql);

  // Parse the returned rows to get the generated ids. Both CLI output shapes
  // are accepted (bare array, or the `{ rows: [...] }` agent-mode envelope);
  // anything else throws rather than yielding an empty list.
  const rows = parseQueryRows(output);
  const primary = rows.find((row) => row.email === primaryEmail);
  const secondary = rows.find((row) => row.email === secondaryEmail);
  const resilience = rows.find((row) => row.email === resilienceEmail);
  const onboardingDesktop = rows.find((row) => row.email === onboardingDesktopEmail);
  const onboardingMobile = rows.find((row) => row.email === onboardingMobileEmail);

  if (!primary || !secondary || !resilience || !onboardingDesktop || !onboardingMobile) {
    // Do not echo the raw output: it can contain password hashes.
    throw new Error(
      'could not create e2e accounts in the local database. ' +
        'Check that `supabase start` is running and that migrations applied.',
    );
  }

  // The ids are interpolated into the accounts file and then into API calls, so
  // they are validated as UUIDs before use. A missing or malformed id would
  // otherwise surface much later as a confusing auth failure.
  const accounts: E2EAccounts = {
    primary: { email: primaryEmail, password: E2E_PASSWORD, userId: requireUuid(primary.id) },
    secondary: {
      email: secondaryEmail,
      password: E2E_PASSWORD,
      userId: requireUuid(secondary.id),
    },
    resilience: {
      email: resilienceEmail,
      password: E2E_PASSWORD,
      userId: requireUuid(resilience.id),
    },
    onboardingDesktop: {
      email: onboardingDesktopEmail,
      password: E2E_PASSWORD,
      userId: requireUuid(onboardingDesktop.id),
    },
    onboardingMobile: {
      email: onboardingMobileEmail,
      password: E2E_PASSWORD,
      userId: requireUuid(onboardingMobile.id),
    },
  };

  writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
  console.log(
    `[e2e] created accounts: ${primaryEmail}, ${secondaryEmail}, ${resilienceEmail}, ` +
      `${onboardingDesktopEmail}, ${onboardingMobileEmail}`,
  );
}

/** A canonical lowercase UUID, as returned by `gen_random_uuid()`. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Validates a generated account id before it is written to the accounts file.
 *
 * The value comes from the database, so it is treated as untrusted. A missing
 * or malformed id is a hard failure: continuing with it would produce a
 * confusing auth error much later in the run.
 */
function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(
      'the local database did not return a valid UUID for a synthetic account id. ' +
        'Refusing to continue with a missing account id.',
    );
  }
  return value;
}

export default globalSetup;
