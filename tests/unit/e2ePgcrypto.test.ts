/**
 * e2ePgcrypto.test.ts — focused tests for pgcrypto schema discovery.
 *
 * The seed statement needs `crypt()` and `gen_salt()`, which belong to the
 * pgcrypto extension. Its schema is not fixed, so it is read from the catalog
 * at setup time. These tests cover the parsing, the validation of the
 * discovered name, and the resulting SQL qualification.
 */

import { describe, expect, it } from 'vitest';
import {
  PGCRYPTO_SCHEMA_QUERY,
  PgcryptoSchemaError,
  assertSafeSchemaName,
  buildPasswordHashExpression,
  parsePgcryptoSchema,
} from '../e2e/pgcrypto';

/** Wraps rows in the CLI's banner + JSON shape. */
function cliOutput(rows: unknown): string {
  return `Connecting to local database...\n${JSON.stringify(rows)}`;
}

describe('PGCRYPTO_SCHEMA_QUERY', () => {
  it('queries pg_extension joined to pg_namespace', () => {
    expect(PGCRYPTO_SCHEMA_QUERY).toContain('pg_extension');
    expect(PGCRYPTO_SCHEMA_QUERY).toContain('pg_namespace');
    expect(PGCRYPTO_SCHEMA_QUERY).toContain('extnamespace');
    expect(PGCRYPTO_SCHEMA_QUERY).toContain("extname = 'pgcrypto'");
  });

  it('selects the schema name as schema_name', () => {
    expect(PGCRYPTO_SCHEMA_QUERY).toContain('n.nspname AS schema_name');
  });
});

describe('parsePgcryptoSchema — valid output', () => {
  it('parses the extensions schema', () => {
    expect(parsePgcryptoSchema(cliOutput([{ schema_name: 'extensions' }]))).toBe('extensions');
  });

  it('parses the public schema', () => {
    expect(parsePgcryptoSchema(cliOutput([{ schema_name: 'public' }]))).toBe('public');
  });

  it('parses a custom schema name', () => {
    expect(parsePgcryptoSchema(cliOutput([{ schema_name: 'crypto_ext' }]))).toBe('crypto_ext');
  });

  it('tolerates surrounding whitespace in the payload', () => {
    const out = `Connecting to local database...\n\n  [ {"schema_name": "extensions"} ]  \n`;
    expect(parsePgcryptoSchema(out)).toBe('extensions');
  });
});

describe('parsePgcryptoSchema — missing extension', () => {
  it('fails clearly when pgcrypto is not installed', () => {
    expect(() => parsePgcryptoSchema(cliOutput([]))).toThrow(PgcryptoSchemaError);
    expect(() => parsePgcryptoSchema(cliOutput([]))).toThrow(/pgcrypto is not installed/);
  });

  it('fails when more than one row is returned', () => {
    const rows = [{ schema_name: 'extensions' }, { schema_name: 'public' }];
    expect(() => parsePgcryptoSchema(cliOutput(rows))).toThrow(/exactly one/);
  });
});

describe('parsePgcryptoSchema — malformed output', () => {
  it('fails when there is no JSON array', () => {
    expect(() => parsePgcryptoSchema('Connecting to local database...\n')).toThrow(
      /no JSON array found/,
    );
  });

  it('fails on empty output', () => {
    expect(() => parsePgcryptoSchema('')).toThrow(PgcryptoSchemaError);
  });

  it('fails on invalid JSON', () => {
    // Brackets present, but the payload between them is not valid JSON.
    expect(() => parsePgcryptoSchema('[{"schema_name": }]')).toThrow(/invalid JSON/);
  });

  it('fails when there is no array to locate', () => {
    expect(() => parsePgcryptoSchema('{"schema_name":"extensions"}')).toThrow(
      /no JSON array found/,
    );
  });

  it('fails when schema_name is missing', () => {
    expect(() => parsePgcryptoSchema(cliOutput([{ other: 'x' }]))).toThrow(
      /did not return a string schema_name/,
    );
  });

  it('fails when schema_name is not a string', () => {
    expect(() => parsePgcryptoSchema(cliOutput([{ schema_name: 42 }]))).toThrow(
      /did not return a string schema_name/,
    );
  });

  it('fails when the row is null', () => {
    expect(() => parsePgcryptoSchema(cliOutput([null]))).toThrow(PgcryptoSchemaError);
  });
});

describe('assertSafeSchemaName — invalid identifiers', () => {
  const invalid = [
    ['empty', ''],
    ['quote', "extensions'"],
    ['double quote', 'extensions"'],
    ['semicolon', 'extensions; drop table auth.users'],
    ['dot', 'public.extensions'],
    ['space', 'ext ensions'],
    ['leading digit', '1extensions'],
    ['dash', 'ext-ensions'],
    ['newline', 'extensions\n'],
    ['comment', 'extensions--'],
    ['too long', 'a'.repeat(64)],
  ] as const;

  for (const [label, value] of invalid) {
    it(`rejects ${label}`, () => {
      expect(() => assertSafeSchemaName(value)).toThrow(PgcryptoSchemaError);
    });
  }

  it('accepts a normal identifier', () => {
    expect(assertSafeSchemaName('extensions')).toBe('extensions');
  });

  it('accepts an underscore-prefixed identifier', () => {
    expect(assertSafeSchemaName('_crypto')).toBe('_crypto');
  });

  it('accepts a 63-character identifier', () => {
    const name = 'a'.repeat(63);
    expect(assertSafeSchemaName(name)).toBe(name);
  });

  it('does not echo the rejected value in the error', () => {
    try {
      assertSafeSchemaName('evil; drop table x');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain('drop table');
    }
  });
});

describe('buildPasswordHashExpression', () => {
  it('qualifies both crypt and gen_salt with the discovered schema', () => {
    const expr = buildPasswordHashExpression('extensions', 'secret');

    expect(expr).toBe("extensions.crypt('secret', extensions.gen_salt('bf'))");
  });

  it('uses the same schema for both functions', () => {
    const expr = buildPasswordHashExpression('public', 'secret');

    expect(expr).toContain('public.crypt(');
    expect(expr).toContain('public.gen_salt(');
    expect(expr).not.toContain('extensions.');
  });

  it('never hard-codes a schema', () => {
    const expr = buildPasswordHashExpression('custom_schema', 'secret');

    expect(expr).toContain('custom_schema.crypt(');
    expect(expr).toContain('custom_schema.gen_salt(');
  });

  it('rejects an unsafe schema before building SQL', () => {
    expect(() => buildPasswordHashExpression("x'; drop table auth.users; --", 'secret')).toThrow(
      PgcryptoSchemaError,
    );
  });

  it('escapes single quotes in the password', () => {
    const expr = buildPasswordHashExpression('extensions', "pa'ss");

    expect(expr).toBe("extensions.crypt('pa''ss', extensions.gen_salt('bf'))");
  });

  it('produces a bcrypt salt request', () => {
    expect(buildPasswordHashExpression('extensions', 'secret')).toContain("gen_salt('bf')");
  });
});
