/**
 * e2eDiagnostics.test.ts — focused tests for the E2E failure diagnostic.
 *
 * These cover the bug that made CI run #6 undiagnosable: the old code used
 * `stderr || stdout`, so any CLI warning on stderr discarded the Postgres
 * error on stdout. Each stream must now be reported independently.
 *
 * The tests also assert that SQL source excerpts and credentials never reach
 * the diagnostic.
 */

import { describe, expect, it } from 'vitest';
import {
  E2E_PASSWORD_FOR_REDACTION,
  buildFailureDiagnostic,
  redactDiagnostic,
  stripSqlExcerpts,
} from '../e2e/diagnostics';

// Fake credentials. None of these are real; they exist only to prove redaction.
// The JWT is assembled at runtime so the repository never contains a literal
// token-shaped string that a secret scanner would flag.
const FAKE_PASSWORD = 'E2eTestPass123!';
const FAKE_EMAIL = 'e2e+primary-1730000000000-ab12cd@example.com';
const FAKE_HASH = '$2a$06$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
const FAKE_JWT = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJyb2xlIjoiYW5vbiJ9', 'abc123def456'].join(
  '.',
);
const FAKE_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const FAKE_SECRET_KEY = 'sb_secret_abcdef123456';

const CLI_WARNING =
  'WARN: config section [inbucket] is deprecated and will be removed in v3, use [local_smtp] instead.';

/** The CLI version reported in every diagnostic. */
const CLI_VERSION = '2.122.1';

const PG_ERROR = [
  'ERROR:  function extensions.crypt(unknown, unknown) does not exist',
  'LINE 12:       extensions.crypt(\'' + FAKE_PASSWORD + '\', extensions.gen_salt(\'bf\')),',
  '               ^',
  'HINT:  No function matches the given name and argument types. You might need to add explicit type casts.',
  'SQLSTATE: 42883',
].join('\n');

describe('buildFailureDiagnostic — stream capture', () => {
  it('reports stderr warnings AND the stdout Postgres error', () => {
    const out = buildFailureDiagnostic({ cliVersion: CLI_VERSION, status: 1, stdout: PG_ERROR, stderr: CLI_WARNING });

    // Both streams must appear, each labelled.
    expect(out).toContain('STDERR (redacted):');
    expect(out).toContain('STDOUT (redacted):');

    // The actionable Postgres detail survives.
    expect(out).toContain('does not exist');
    expect(out).toContain('SQLSTATE: 42883');
    expect(out).toContain('HINT:');

    // The CLI warning is still visible (it is not the cause, but it is context).
    expect(out).toContain('inbucket');

    // Exit status is reported.
    expect(out).toContain('exit status 1');
  });

  it('reports a structured CLI error on stdout with warnings on stderr', () => {
    const structured = JSON.stringify({
      _tag: 'Error',
      error: { code: 'DbConnectError', message: 'failed to connect to postgres' },
    });
    const out = buildFailureDiagnostic({ cliVersion: CLI_VERSION, status: 1, stdout: structured, stderr: CLI_WARNING });

    expect(out).toContain('STDOUT (redacted):');
    expect(out).toContain('DbConnectError');
    expect(out).toContain('STDERR (redacted):');
    expect(out).toContain('inbucket');
  });

  it('reports only stderr when stdout is empty', () => {
    const out = buildFailureDiagnostic({ cliVersion: CLI_VERSION, status: 1, stdout: '', stderr: CLI_WARNING });

    expect(out).toContain('STDERR (redacted):');
    expect(out).not.toContain('STDOUT (redacted):');
    expect(out).not.toContain('<no output>');
  });

  it('reports only stdout when stderr is empty', () => {
    const out = buildFailureDiagnostic({ cliVersion: CLI_VERSION, status: 1, stdout: PG_ERROR, stderr: '' });

    expect(out).toContain('STDOUT (redacted):');
    expect(out).not.toContain('STDERR (redacted):');
    expect(out).not.toContain('<no output>');
  });

  it('reports <no output> only when both streams are empty', () => {
    const out = buildFailureDiagnostic({ cliVersion: CLI_VERSION, status: 1, stdout: '', stderr: '' });

    expect(out).toContain('<no output>');
    expect(out).not.toContain('STDOUT (redacted):');
    expect(out).not.toContain('STDERR (redacted):');
  });

  it('treats whitespace-only streams as empty', () => {
    const out = buildFailureDiagnostic({ cliVersion: CLI_VERSION, status: 1, stdout: '   \n\n  ', stderr: '\t\n ' });

    expect(out).toContain('<no output>');
  });

  it('handles an unknown exit status', () => {
    const out = buildFailureDiagnostic({ cliVersion: CLI_VERSION, status: null, stdout: '', stderr: CLI_WARNING });

    expect(out).toContain('exit status unknown');
  });
});

describe('buildFailureDiagnostic — CLI identity and stream sizes', () => {
  it('reports the CLI version that actually ran', () => {
    const out = buildFailureDiagnostic({
      cliVersion: CLI_VERSION,
      status: 1,
      stdout: '',
      stderr: CLI_WARNING,
    });

    expect(out).toContain(`CLI version: ${CLI_VERSION}`);
  });

  it('reports the exit status and the signal separately', () => {
    const out = buildFailureDiagnostic({
      cliVersion: CLI_VERSION,
      status: null,
      signal: 'SIGKILL',
      stdout: '',
      stderr: CLI_WARNING,
    });

    expect(out).toContain('Exit status: unknown');
    expect(out).toContain('Signal: SIGKILL');
  });

  it('reports "none" when the process exited on its own', () => {
    const out = buildFailureDiagnostic({
      cliVersion: CLI_VERSION,
      status: 1,
      stdout: '',
      stderr: CLI_WARNING,
    });

    expect(out).toContain('Signal: none');
  });

  it('reports the raw byte count of each stream', () => {
    const out = buildFailureDiagnostic({
      cliVersion: CLI_VERSION,
      status: 1,
      stdout: 'abcde',
      stderr: 'xy',
    });

    expect(out).toContain('stdout bytes: 5');
    expect(out).toContain('stderr bytes: 2');
  });

  it('counts bytes, not characters, for multi-byte output', () => {
    // "é" is two bytes in UTF-8 but one character.
    const out = buildFailureDiagnostic({
      cliVersion: CLI_VERSION,
      status: 1,
      stdout: 'é',
      stderr: '',
    });

    expect(out).toContain('stdout bytes: 2');
  });

  it('flags stdout that held only the connection banner', () => {
    const out = buildFailureDiagnostic({
      cliVersion: CLI_VERSION,
      status: 1,
      stdout: 'Connecting to local database...\n',
      stderr: CLI_WARNING,
    });

    expect(out).toContain('stdout was only the connection banner: yes');
  });

  it('does not flag stdout that carried a payload', () => {
    const out = buildFailureDiagnostic({
      cliVersion: CLI_VERSION,
      status: 1,
      stdout: PG_ERROR,
      stderr: CLI_WARNING,
    });

    expect(out).toContain('stdout was only the connection banner: no');
  });

  it('flags empty stdout as banner-only', () => {
    const out = buildFailureDiagnostic({
      cliVersion: CLI_VERSION,
      status: 1,
      stdout: '',
      stderr: CLI_WARNING,
    });

    expect(out).toContain('stdout was only the connection banner: yes');
  });
});

describe('buildFailureDiagnostic — SQL and credential protection', () => {
  it('never exposes the SQL source line or caret marker', () => {
    const out = buildFailureDiagnostic({ cliVersion: CLI_VERSION, status: 1, stdout: PG_ERROR, stderr: CLI_WARNING });

    expect(out).not.toContain('LINE 12:');
    expect(out).not.toContain('extensions.gen_salt');
    expect(out).not.toMatch(/^\s*\^+\s*$/m);
    expect(out).toContain('<sql excerpt removed>');
  });

  it('redacts the password, email, hash, JWT, db url and secret key', () => {
    const noisy = [
      CLI_WARNING,
      `insert failed for ${FAKE_EMAIL}`,
      `encrypted_password = ${FAKE_HASH}`,
      `ANON_KEY=${FAKE_JWT}`,
      `connecting to ${FAKE_DB_URL}`,
      `key ${FAKE_SECRET_KEY} rejected`,
      `crypt('${FAKE_PASSWORD}', gen_salt('bf'))`,
    ].join('\n');

    const out = buildFailureDiagnostic({ cliVersion: CLI_VERSION, status: 1, stdout: noisy, stderr: noisy });

    expect(out).not.toContain(FAKE_PASSWORD);
    expect(out).not.toContain(FAKE_EMAIL);
    expect(out).not.toContain(FAKE_HASH);
    expect(out).not.toContain(FAKE_JWT);
    expect(out).not.toContain(FAKE_DB_URL);
    expect(out).not.toContain(FAKE_SECRET_KEY);

    expect(out).toContain('<redacted-password>');
    expect(out).toContain('<redacted-email>');
    expect(out).toContain('<redacted-hash>');
    expect(out).toContain('<redacted-jwt>');
    expect(out).toContain('<redacted-db-url>');
    expect(out).toContain('<redacted-key>');
  });

  it('keeps SQLSTATE, message, detail and hint', () => {
    const withDetail = [
      'ERROR:  duplicate key value violates unique constraint "users_email_key"',
      'DETAIL:  Key (email)=(x@example.com) already exists.',
      'HINT:  Use a different email.',
      'SQLSTATE: 23505',
    ].join('\n');

    const out = buildFailureDiagnostic({ cliVersion: CLI_VERSION, status: 1, stdout: withDetail, stderr: '' });

    expect(out).toContain('ERROR:');
    expect(out).toContain('DETAIL:');
    expect(out).toContain('HINT:');
    expect(out).toContain('SQLSTATE: 23505');
  });
});

describe('stripSqlExcerpts', () => {
  it('removes a LINE excerpt and its caret marker', () => {
    const out = stripSqlExcerpts(PG_ERROR);

    expect(out).not.toContain('LINE 12:');
    expect(out).not.toMatch(/\^/);
    expect(out).toContain('<sql excerpt removed>');
    expect(out).toContain('does not exist');
  });

  it('removes the CLI connection banner', () => {
    const out = stripSqlExcerpts('Connecting to local database...\nERROR: boom');

    expect(out).not.toContain('Connecting to local database');
    expect(out).toContain('ERROR: boom');
  });

  it('leaves ordinary text untouched', () => {
    const out = stripSqlExcerpts('ERROR: something failed\nSQLSTATE: 42P01');

    expect(out).toBe('ERROR: something failed\nSQLSTATE: 42P01');
  });
});

describe('redactDiagnostic', () => {
  it('leaves non-sensitive text unchanged', () => {
    const text = 'ERROR: relation "public.invoices" does not exist';

    expect(redactDiagnostic(text)).toBe(text);
  });

  it('redacts every generated e2e email in a list', () => {
    const text =
      'created e2e+primary-1-aa@example.com, e2e+secondary-2-bb@example.com, e2e+onboarding-3-cc@example.com';
    const out = redactDiagnostic(text);

    expect(out).not.toContain('e2e+primary');
    expect(out).not.toContain('e2e+secondary');
    expect(out).not.toContain('e2e+onboarding');
  });

  it('uses the same password constant as the E2E fixtures', () => {
    // diagnostics.ts duplicates the constant to stay free of Node imports.
    // This guards against the two drifting apart.
    expect(E2E_PASSWORD_FOR_REDACTION).toBe(FAKE_PASSWORD);
  });
});
