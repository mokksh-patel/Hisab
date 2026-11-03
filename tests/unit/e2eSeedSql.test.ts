/**
 * e2eSeedSql.test.ts — focused tests for the E2E account seeding statement.
 *
 * The bug these guard against: the seed used to insert only `auth.users` rows.
 * The users existed, were confirmed and had correct bcrypt hashes, but had zero
 * rows in `auth.identities`, so GoTrue could not resolve a sign-in and every
 * browser test failed at login.
 *
 * The statement is asserted structurally here (no database needed). The exact
 * shape was verified against the local stack: `auth.identities.id` is defaulted
 * and `auth.identities.email` is a generated column, so neither may appear in
 * the INSERT column list.
 */

import { describe, expect, it } from 'vitest';
import { buildSeedSql, type SeedAccount } from '../e2e/seed-sql';

const HASH = "extensions.crypt('secret', extensions.gen_salt('bf'))";

const ACCOUNTS: SeedAccount[] = [
  { email: 'e2e+primary-1-aa@example.com', fullName: 'E2E Primary' },
  { email: 'e2e+secondary-2-bb@example.com', fullName: 'E2E Secondary' },
  { email: 'e2e+resilience-3-cc@example.com', fullName: 'E2E Resilience' },
  { email: 'e2e+onboarding-4-dd@example.com', fullName: 'E2E Onboarding' },
];

/** Collapses runs of whitespace so assertions do not depend on indentation. */
function flat(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

describe('buildSeedSql — users', () => {
  it('inserts into auth.users', () => {
    expect(flat(buildSeedSql(ACCOUNTS, HASH))).toContain('insert into auth.users');
  });

  it('includes every account email', () => {
    const sql = buildSeedSql(ACCOUNTS, HASH);
    for (const account of ACCOUNTS) {
      expect(sql).toContain(account.email);
    }
  });

  it('includes every account full name', () => {
    const sql = buildSeedSql(ACCOUNTS, HASH);
    for (const account of ACCOUNTS) {
      expect(sql).toContain(account.fullName);
    }
  });

  it('uses the supplied password hash expression verbatim', () => {
    expect(buildSeedSql(ACCOUNTS, HASH)).toContain(HASH);
  });

  it('confirms the email address', () => {
    expect(flat(buildSeedSql(ACCOUNTS, HASH))).toContain('email_confirmed_at');
  });

  it('writes empty strings for the GoTrue token columns', () => {
    // A NULL there makes GoTrue fail with "Database error querying schema".
    expect(flat(buildSeedSql(ACCOUNTS, HASH))).toContain("'', '', '', '', '', '', '', ''");
  });

  it('returns id and email', () => {
    expect(flat(buildSeedSql(ACCOUNTS, HASH))).toContain('select id, email from inserted');
  });
});

describe('buildSeedSql — identities', () => {
  it('inserts into auth.identities', () => {
    expect(flat(buildSeedSql(ACCOUNTS, HASH))).toContain('insert into auth.identities');
  });

  it('sets provider_id to the user id as text', () => {
    expect(flat(buildSeedSql(ACCOUNTS, HASH))).toContain('i.id::text');
  });

  it('sets user_id to the user id', () => {
    expect(flat(buildSeedSql(ACCOUNTS, HASH))).toContain('i.id,');
  });

  it("sets provider to 'email'", () => {
    expect(flat(buildSeedSql(ACCOUNTS, HASH))).toContain("'email',");
  });

  it('builds identity_data with sub, email, email_verified and phone_verified', () => {
    const sql = flat(buildSeedSql(ACCOUNTS, HASH));

    expect(sql).toContain("'sub', i.id::text");
    expect(sql).toContain("'email', i.email");
    expect(sql).toContain("'email_verified', true");
    expect(sql).toContain("'phone_verified', false");
  });

  it('sets created_at and updated_at to now()', () => {
    const sql = flat(buildSeedSql(ACCOUNTS, HASH));

    expect(sql).toContain('created_at, updated_at');
    expect(sql).toContain('now(), now()');
  });

  it('never inserts the generated email column', () => {
    // auth.identities.email is GENERATED ALWAYS AS (lower(identity_data->>'email')).
    // Writing it is an error, so it must not appear in the column list.
    const columnList = /insert into auth\.identities \(([^)]*)\)/.exec(
      flat(buildSeedSql(ACCOUNTS, HASH)),
    );

    expect(columnList).not.toBeNull();
    const columns = (columnList?.[1] ?? '').split(',').map((c) => c.trim());
    expect(columns).not.toContain('email');
  });

  it('never inserts the defaulted id column', () => {
    // auth.identities.id has DEFAULT gen_random_uuid(); it is left to the schema.
    const columnList = /insert into auth\.identities \(([^)]*)\)/.exec(
      flat(buildSeedSql(ACCOUNTS, HASH)),
    );

    const columns = (columnList?.[1] ?? '').split(',').map((c) => c.trim());
    expect(columns).not.toContain('id');
  });

  it('is safe against duplicate identities', () => {
    expect(flat(buildSeedSql(ACCOUNTS, HASH))).toContain(
      'on conflict (provider_id, provider) do nothing',
    );
  });
});

describe('buildSeedSql — single logical operation', () => {
  it('inserts users through a data-modifying CTE', () => {
    expect(flat(buildSeedSql(ACCOUNTS, HASH))).toContain('inserted as ( insert into auth.users');
  });

  it('inserts identities from the users CTE, not from a table scan', () => {
    // Sourcing from `inserted` is what restricts identity creation to the users
    // this statement just created, and keeps both writes in one statement.
    expect(flat(buildSeedSql(ACCOUNTS, HASH))).toContain('from inserted i');
  });

  it('does not select identities from auth.users directly', () => {
    const sql = flat(buildSeedSql(ACCOUNTS, HASH));
    const identityInsert = sql.slice(sql.indexOf('insert into auth.identities'));

    expect(identityInsert).not.toContain('from auth.users');
  });

  it('emits exactly one statement', () => {
    // A single trailing semicolon; no second statement that could run separately.
    const sql = buildSeedSql(ACCOUNTS, HASH).trim();
    expect(sql.endsWith(';')).toBe(true);
    expect(sql.slice(0, -1)).not.toContain(';');
  });
});

describe('buildSeedSql — input handling', () => {
  it('rejects an empty account list', () => {
    expect(() => buildSeedSql([], HASH)).toThrow(/at least one account/);
  });

  it('escapes single quotes in an email', () => {
    const sql = buildSeedSql([{ email: "o'brien@example.com", fullName: 'X' }], HASH);

    expect(sql).toContain("'o''brien@example.com'");
  });

  it('escapes single quotes in a full name', () => {
    const sql = buildSeedSql([{ email: 'a@example.com', fullName: "O'Brien" }], HASH);

    expect(sql).toContain("'O''Brien'");
  });

  it('handles a single account', () => {
    const sql = buildSeedSql([ACCOUNTS[0]!], HASH);

    expect(sql).toContain(ACCOUNTS[0]!.email);
    expect(flat(sql)).toContain('insert into auth.identities');
  });
});
