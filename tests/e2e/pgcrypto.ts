/**
 * e2e/pgcrypto.ts — discovers where pgcrypto actually lives, and builds the
 * schema-qualified password-hashing expression.
 *
 * WHY THIS EXISTS
 *   The seed statement needs `crypt(text, text)` and `gen_salt(text)`. Those
 *   functions belong to the pgcrypto extension, and the extension's schema is
 *   NOT guaranteed to be `public` or `extensions` — it depends on how the
 *   database was provisioned. Hard-coding either name produced:
 *
 *     ERROR: function extensions.crypt(unknown, unknown) does not exist
 *     SQLSTATE: 42883
 *
 *   So the schema is read from the PostgreSQL catalog at setup time and used
 *   to qualify both calls.
 *
 * SECURITY
 *   The schema name comes from the database, so it is treated as untrusted
 *   input: it is validated against a strict identifier pattern before being
 *   interpolated into SQL. Anything else is rejected rather than escaped,
 *   because a legitimate schema name never needs escaping.
 *
 * This module is deliberately free of Node built-ins so the unit-test project
 * (which has no Node types) can import it.
 */

/**
 * The catalog query. `pg_extension.extnamespace` is the schema that owns the
 * extension's objects, which is exactly what qualification needs.
 */
export const PGCRYPTO_SCHEMA_QUERY = `
  SELECT n.nspname AS schema_name
  FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'pgcrypto';
`.trim();

/**
 * A conservative PostgreSQL identifier: starts with a letter or underscore,
 * then letters, digits, underscores or `$`. Deliberately excludes quotes,
 * dots, whitespace and semicolons so the value cannot alter the statement.
 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** Longest identifier PostgreSQL allows (NAMEDATALEN - 1). */
const MAX_IDENTIFIER_LENGTH = 63;

export class PgcryptoSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PgcryptoSchemaError';
  }
}

/**
 * Validates a schema name before it is used in SQL.
 *
 * Throws rather than escaping: a real schema name always matches the pattern,
 * so a mismatch means the value is not what we think it is.
 */
export function assertSafeSchemaName(name: string): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new PgcryptoSchemaError('pgcrypto schema name is empty.');
  }
  if (name.length > MAX_IDENTIFIER_LENGTH) {
    throw new PgcryptoSchemaError(
      `pgcrypto schema name is longer than ${MAX_IDENTIFIER_LENGTH} characters.`,
    );
  }
  if (!SAFE_IDENTIFIER.test(name)) {
    // Do not echo the value: it is untrusted and may contain control characters.
    throw new PgcryptoSchemaError(
      'pgcrypto schema name is not a valid PostgreSQL identifier. ' +
        'Refusing to build SQL from it.',
    );
  }
  return name;
}

/**
 * Extracts the schema name from `supabase db query --output json` output.
 *
 * The CLI prints a "Connecting to local database..." banner before the JSON
 * payload, so the array is located by its brackets rather than by parsing the
 * whole stream.
 *
 * Requires EXACTLY ONE row. Zero rows means pgcrypto is not installed; more
 * than one means the catalog returned something unexpected. Both are hard
 * failures — guessing would produce a confusing 42883 later.
 */
export function parsePgcryptoSchema(output: string): string {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');

  if (start === -1 || end === -1 || end < start) {
    throw new PgcryptoSchemaError(
      'could not parse the pgcrypto schema query output: no JSON array found. ' +
        'The Supabase CLI may have failed before running the query.',
    );
  }

  let rows: unknown;
  try {
    rows = JSON.parse(output.slice(start, end + 1));
  } catch {
    throw new PgcryptoSchemaError(
      'could not parse the pgcrypto schema query output: invalid JSON.',
    );
  }

  if (!Array.isArray(rows)) {
    throw new PgcryptoSchemaError(
      'could not parse the pgcrypto schema query output: expected an array of rows.',
    );
  }

  if (rows.length === 0) {
    throw new PgcryptoSchemaError(
      'pgcrypto is not installed in the local database ' +
        '(no row in pg_extension for extname = pgcrypto). ' +
        'Run `supabase start` so migrations apply, then retry.',
    );
  }

  if (rows.length > 1) {
    throw new PgcryptoSchemaError(
      `expected exactly one pgcrypto extension row, found ${rows.length}.`,
    );
  }

  const row = rows[0] as Record<string, unknown> | null;
  const schema = row && typeof row === 'object' ? row.schema_name : undefined;

  if (typeof schema !== 'string') {
    throw new PgcryptoSchemaError(
      'the pgcrypto schema query did not return a string schema_name column.',
    );
  }

  return assertSafeSchemaName(schema);
}

/**
 * Builds the schema-qualified bcrypt expression used for the seed password.
 *
 * Both functions are qualified with the SAME discovered schema, because they
 * are both provided by pgcrypto and therefore live together.
 */
export function buildPasswordHashExpression(schema: string, password: string): string {
  const safeSchema = assertSafeSchemaName(schema);
  // The password is a fixed test constant containing no quotes, but it is
  // escaped anyway so this helper stays correct if the constant ever changes.
  const escapedPassword = password.replace(/'/g, "''");
  return `${safeSchema}.crypt('${escapedPassword}', ${safeSchema}.gen_salt('bf'))`;
}
