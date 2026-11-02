/**
 * e2e/env.ts — the single source of truth for the E2E Supabase connection.
 *
 * SECURITY MODEL
 *   The E2E suite must never be able to reach a hosted Supabase project. Every
 *   value used here is validated before use:
 *
 *     1. The URL must parse as http(s) and its hostname must be a loopback
 *        address (localhost / 127.0.0.1 / ::1). Anything else fails closed.
 *     2. Only the publishable (anon) key is ever read. A service-role key is
 *        never requested, never read and never logged.
 *     3. `.env.local` is NOT loaded automatically. The suite reads dedicated
 *        E2E_* variables so a developer's test-project configuration cannot
 *        leak into an E2E run.
 *
 *   The app under test (Vite) still reads VITE_SUPABASE_URL /
 *   VITE_SUPABASE_PUBLISHABLE_KEY. Those are pointed at the same local stack by
 *   the caller (see playwright.config.ts), so the browser and the fixtures talk
 *   to one database.
 */

/** Loopback hostnames that are unambiguously local. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export class E2EConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'E2EConfigError';
  }
}

export interface E2EConfig {
  /** Local Supabase API URL, e.g. http://127.0.0.1:54321 */
  url: string;
  /** Publishable / anon key. Never a service-role key. */
  publishableKey: string;
}

/**
 * Returns true when the hostname is a loopback address.
 * Exported so it can be unit-tested without touching process.env.
 */
export function isLoopbackUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
}

/**
 * Reads and validates the E2E configuration.
 *
 * Throws E2EConfigError when the configuration is missing or points anywhere
 * other than loopback. Callers must NOT catch this to skip tests: a missing or
 * remote configuration is a hard failure, not a reason to pass silently.
 */
export function readE2EConfig(env: NodeJS.ProcessEnv = process.env): E2EConfig {
  const url = (env.E2E_SUPABASE_URL ?? '').trim();
  const publishableKey = (env.E2E_SUPABASE_PUBLISHABLE_KEY ?? '').trim();

  if (!url || !publishableKey) {
    throw new E2EConfigError(
      'E2E Supabase configuration is missing. Set E2E_SUPABASE_URL and ' +
        'E2E_SUPABASE_PUBLISHABLE_KEY to the LOCAL Supabase stack ' +
        '(run `supabase start`, then `supabase status`).',
    );
  }

  if (!isLoopbackUrl(url)) {
    // Deliberately does not echo the URL: it may contain a project ref.
    throw new E2EConfigError(
      'E2E_SUPABASE_URL must point at a loopback address ' +
        '(localhost, 127.0.0.1 or ::1). Refusing to run E2E against a remote ' +
        'Supabase project.',
    );
  }

  return { url, publishableKey };
}

/**
 * True when a configuration is present AND local. Used only to decide whether
 * to *attempt* setup; it never causes tests to be skipped.
 */
export function hasLocalE2EConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    readE2EConfig(env);
    return true;
  } catch {
    return false;
  }
}

/**
 * Derives the browser localStorage key Supabase JS uses for the session.
 *
 * supabase-js builds it as `sb-<project-ref>-auth-token`, where the ref is the
 * first label of the API hostname. For a local stack the host is 127.0.0.1, so
 * the key is `sb-127-auth-token`. Deriving it keeps the remote project ref out
 * of the test code entirely.
 */
export function authStorageKey(url: string): string {
  const host = new URL(url).hostname;
  const ref = host.split('.')[0] ?? host;
  return `sb-${ref}-auth-token`;
}
