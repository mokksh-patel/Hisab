/**
 * e2e/seed-sql.ts — builds the SQL that seeds the synthetic E2E accounts.
 *
 * WHY THIS IS A SEPARATE MODULE
 *   The statement is the part of the setup most likely to break silently: it
 *   touches `auth.users` and `auth.identities`, whose shapes are owned by
 *   GoTrue and differ between versions. Keeping the builder free of Node
 *   built-ins lets the unit-test project assert its structure without a
 *   database, and keeps global-setup.ts focused on process handling.
 *
 * WHY IDENTITIES ARE REQUIRED
 *   A row in `auth.users` alone is NOT a usable account. GoTrue resolves a
 *   sign-in by looking up the provider identity in `auth.identities`; with no
 *   `email` identity, `signInWithPassword` fails even though the user row
 *   exists, the email is confirmed and the bcrypt hash is correct. The seed
 *   therefore writes both rows in one statement.
 *
 * SCHEMA FACTS (verified against the local stack, CLI 2.122.1)
 *   auth.identities:
 *     id           uuid  NOT NULL DEFAULT gen_random_uuid()   -- never inserted
 *     provider_id  text  NOT NULL
 *     user_id      uuid  NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE
 *     identity_data jsonb NOT NULL
 *     provider     text  NOT NULL
 *     email        text  GENERATED ALWAYS AS (lower(identity_data ->> 'email'))
 *     created_at / updated_at  timestamptz NULL
 *     UNIQUE (provider_id, provider)
 *
 *   `id` and `email` are therefore omitted from the INSERT: `id` is defaulted
 *   and `email` is a generated column that cannot be written at all.
 *
 * SECURITY
 *   Emails are generated locally from a timestamp and a random suffix, so they
 *   contain no quotes and are safe to inline. The password is escaped by
 *   buildPasswordHashExpression. The schema name is validated before it is
 *   interpolated. Nothing here reads from the database.
 */

/** One synthetic account to seed. */
export interface SeedAccount {
  email: string;
  fullName: string;
}

/**
 * Builds the single statement that inserts every synthetic user together with
 * its matching `email` identity.
 *
 * The users are inserted by a data-modifying CTE (`inserted`), and the
 * identities are inserted from that CTE in the same statement. That makes the
 * two writes one logical operation: either both land or neither does, and the
 * identity rows can only ever reference the users this statement just created.
 *
 * `on conflict (provider_id, provider) do nothing` makes the identity insert
 * idempotent. The unique constraint is on (provider_id, provider), and
 * provider_id is the user id, so a re-run cannot create a second identity for
 * the same user.
 *
 * The final SELECT returns `id` and `email` for each seeded user, which is the
 * shape `parseQueryRows` expects.
 *
 * @param accounts  The accounts to create. Must be non-empty.
 * @param passwordHashExpression  A schema-qualified crypt() expression, as
 *   produced by buildPasswordHashExpression.
 */
export function buildSeedSql(
  accounts: readonly SeedAccount[],
  passwordHashExpression: string,
): string {
  if (accounts.length === 0) {
    throw new Error('buildSeedSql requires at least one account.');
  }

  // Each account becomes one VALUES row. Emails and names are generated
  // locally and contain no quotes, but they are escaped anyway so this helper
  // stays correct if a caller ever passes something else.
  const values = accounts
    .map((account) => `(${quoteLiteral(account.email)}, ${quoteLiteral(account.fullName)})`)
    .join(',\n      ');

  return `
    with seed(email, full_name) as (
      values
      ${values}
    ),
    inserted as (
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
        s.email,
        ${passwordHashExpression},
        now(), now(), now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_build_object('full_name', s.full_name),
        false, false,
        '', '', '', '', '', '', '', ''
      from seed s
      returning id, email
    ),
    identities as (
      insert into auth.identities (
        provider_id, user_id, identity_data, provider, created_at, updated_at
      )
      select
        i.id::text,
        i.id,
        jsonb_build_object(
          'sub', i.id::text,
          'email', i.email,
          'email_verified', true,
          'phone_verified', false
        ),
        'email',
        now(),
        now()
      from inserted i
      on conflict (provider_id, provider) do nothing
      returning user_id
    )
    select id, email from inserted;
  `;
}

/**
 * Quotes a value as a PostgreSQL string literal.
 *
 * Doubles embedded single quotes, which is the only escape a standard-conforming
 * string literal needs. Backslashes are left alone: `standard_conforming_strings`
 * is on by default, so they are literal.
 */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
