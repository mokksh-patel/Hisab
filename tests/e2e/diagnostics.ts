/**
 * e2e/diagnostics.ts — redaction and failure formatting for E2E setup.
 *
 * Deliberately free of Node built-ins and of any import that pulls in
 * `process`, `node:fs` or `node:child_process`. That keeps it importable from
 * the unit-test project (which has no Node types) as well as from
 * global-setup.ts (which does).
 *
 * The E2E password is duplicated here rather than imported from fixtures.ts,
 * because fixtures.ts imports `@supabase/supabase-js` and Node built-ins.
 * Keep the two values in sync — the unit test asserts they match.
 */

import { isBannerOnly } from './cli-output';

/** Must equal E2E_PASSWORD in fixtures.ts. */
export const E2E_PASSWORD_FOR_REDACTION = 'E2eTestPass123!';

/**
 * Redacts anything sensitive from CLI/Postgres output before it is reported.
 *
 * The goal is a diagnostic that is useful in a CI log without leaking secrets
 * or the SQL statement. Applied to stderr and stdout independently.
 */
export function redactDiagnostic(text: string): string {
  let out = text;

  // Generated E2E email addresses (e2e+<label>-<stamp>@example.com).
  out = out.replace(/e2e\+[^\s'"@]*@[^\s'"]*/gi, '<redacted-email>');

  // Any other email address.
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<redacted-email>');

  // bcrypt hashes ($2a$/$2b$/$2y$...) and any other crypt() output.
  // This must run BEFORE the generic `password=` rule below, otherwise that
  // rule would consume the hash and the more specific marker would be lost.
  // The trailing class is greedy to the end of the token so no hash fragment
  // survives.
  out = out.replace(/\$2[aby]?\$\d{2}\$[./A-Za-z0-9]+/g, '<redacted-hash>');

  // JWTs (three base64url segments) — covers anon, service-role and any token.
  out = out.replace(/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g, '<redacted-jwt>');

  // Supabase publishable/secret keys.
  out = out.replace(/sb_(publishable|secret)_[A-Za-z0-9_-]+/g, '<redacted-key>');

  // Connection strings / passwords.
  out = out.replace(/postgres(ql)?:\/\/[^\s'"]+/gi, '<redacted-db-url>');
  // Only redact a `password=` assignment when the value is not already a
  // placeholder, so an earlier, more specific marker is preserved.
  out = out.replace(/(password|passwd|pwd)\s*=\s*(?!<redacted)([^\s'";]+)/gi, '$1=<redacted>');

  // The E2E password constant, in case it ever appears verbatim.
  out = out.split(E2E_PASSWORD_FOR_REDACTION).join('<redacted-password>');

  return out;
}

/**
 * Removes SQL source excerpts from a Postgres error report.
 *
 * Postgres echoes the offending statement as `LINE n: ...` followed by a caret
 * (`^`) marker line. Those lines reproduce query text, so they are dropped
 * while the SQLSTATE, MESSAGE, DETAIL and HINT lines are kept — those are what
 * make the failure actionable.
 *
 * Also drops the CLI's own "Connecting to local database..." banner, which
 * carries no diagnostic value.
 */
export function stripSqlExcerpts(text: string): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    // `LINE 12: crypt('...')` — the echoed source line.
    if (/^\s*LINE\s+\d+\s*:/.test(line)) {
      // Skip the caret marker that follows it, if present.
      const next = lines[i + 1] ?? '';
      if (/^\s*\^+\s*$/.test(next)) i += 1;
      kept.push('<sql excerpt removed>');
      continue;
    }

    // A bare caret marker line with no preceding LINE (defensive).
    if (/^\s*\^+\s*$/.test(line)) continue;

    // CLI connection banner.
    if (/^Connecting to local database\.\.\.\s*$/.test(line)) continue;

    kept.push(line);
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Formats one captured stream for the diagnostic, or null when it is empty. */
function formatStream(label: 'STDERR' | 'STDOUT', raw: string): string | null {
  const cleaned = stripSqlExcerpts(raw);
  if (!cleaned) return null;
  return `${label} (redacted):\n${redactDiagnostic(cleaned)}`;
}

/**
 * Counts the UTF-8 bytes in a string.
 *
 * Implemented here rather than with `Buffer.byteLength` so this module stays
 * free of Node built-ins and remains importable from the unit-test project,
 * which has no Node types. The count is what tells "the CLI printed nothing"
 * apart from "the CLI printed something we could not parse".
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/** Everything the diagnostic needs about one failed CLI invocation. */
export interface CliFailure {
  /** The Supabase CLI version that actually ran, e.g. "2.122.1". */
  cliVersion: string;
  /** Process exit status, or null when the process was killed by a signal. */
  status: number | null;
  /** Terminating signal, when the process did not exit on its own. */
  signal?: string | null;
  stdout: string;
  stderr: string;
}

/**
 * Builds the failure diagnostic from BOTH captured streams.
 *
 * Each stream is reported independently. An earlier version used
 * `stderr || stdout`, which silently discarded stdout whenever the CLI wrote
 * any warning to stderr — and the Supabase CLI writes warnings there on every
 * run, while the actual Postgres error goes to stdout. That made CI failures
 * undiagnosable.
 *
 * The header also records the CLI version, the exit status, the signal (if
 * any) and the raw byte count of each stream. Those four facts are what
 * distinguish "the wrong CLI ran" from "the CLI ran and the query failed" from
 * "the CLI printed nothing at all" — the ambiguity that made the original CI
 * failure impossible to diagnose.
 *
 * `bannerOnly` is reported explicitly because a stdout holding nothing but the
 * "Connecting to local database..." banner means the query never executed,
 * which is a different problem from a query that executed and failed.
 */
export function buildFailureDiagnostic(failure: CliFailure): string {
  const { cliVersion, status, signal, stdout, stderr } = failure;

  const sections = [formatStream('STDERR', stderr), formatStream('STDOUT', stdout)].filter(
    (section): section is string => section !== null,
  );

  const body = sections.length > 0 ? sections.join('\n\n') : '<no output>';

  const statusText = status === null ? 'unknown' : String(status);
  const signalText = signal ? signal : 'none';

  return (
    `[e2e] seeding synthetic auth users failed (exit status ${statusText}).\n` +
    `--- supabase db query --local ---\n` +
    `CLI version: ${cliVersion}\n` +
    `Exit status: ${statusText}\n` +
    `Signal: ${signalText}\n` +
    `stdout bytes: ${utf8ByteLength(stdout)}\n` +
    `stderr bytes: ${utf8ByteLength(stderr)}\n` +
    `stdout was only the connection banner: ${isBannerOnly(stdout) ? 'yes' : 'no'}\n` +
    `--- output ---\n${body}\n` +
    '--- end output ---'
  );
}
