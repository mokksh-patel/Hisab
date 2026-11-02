/**
 * test-view-rls.mjs — verify invoice_item_discounts respects RLS and tenant
 * isolation for two different businesses.
 *
 * The view uses security_invoker = true, so the caller's RLS applies. This test
 * proves that a member of business A cannot see business B's line discounts.
 *
 * SAFETY: schema `rls_test`, dropped afterwards. Uses synthetic UUIDs only.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN_REF = 'gdhaszmgwowfxgxllpva';
const SCHEMA = 'rls_test';

function runQuery(sql) {
  const tmp = join('backups', '.tmp-rls.sql');
  writeFileSync(tmp, sql, 'utf8');
  const output = execSync(`npx --yes supabase db query --linked --output json --file "${tmp}"`, {
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 50 * 1024 * 1024,
  });
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  return JSON.parse(output.slice(start, end + 1));
}

const ref = readFileSync('supabase/.temp/project-ref', 'utf8').trim();
if (ref === FORBIDDEN_REF) {
  console.error(`REFUSING: linked project is production (${ref})`);
  process.exit(1);
}
console.log(`View RLS test against ${ref} (schema: ${SCHEMA})\n`);

runQuery(`drop schema if exists ${SCHEMA} cascade;`);
runQuery(`create schema ${SCHEMA};`);

// --- Build a minimal tenant model ------------------------------------------
runQuery(`
  create type ${SCHEMA}.discount_type as enum ('none', 'percent', 'fixed');

  create table ${SCHEMA}.business_members (
    business_id uuid not null,
    user_id uuid not null,
    invitation_status text not null default 'accepted',
    primary key (business_id, user_id)
  );

  create table ${SCHEMA}.invoices (
    id uuid primary key,
    business_id uuid not null,
    document_state text not null default 'issued'
  );

  create table ${SCHEMA}.invoice_items (
    id uuid primary key,
    business_id uuid not null,
    invoice_id uuid not null references ${SCHEMA}.invoices (id),
    discount_percent_basis_points integer not null default 0,
    discount_paise numeric(20,0) not null default 0,
    discount_type ${SCHEMA}.discount_type not null default 'none',
    discount_value numeric(20,0) not null default 0
  );

  -- Membership helper mirroring public.is_business_member
  create or replace function ${SCHEMA}.is_member(p_business_id uuid)
  returns boolean language sql stable security definer
  set search_path = ${SCHEMA}, pg_temp
  as $$
    select exists (
      select 1 from ${SCHEMA}.business_members m
      where m.business_id = p_business_id
        and m.user_id = auth.uid()
        and m.invitation_status = 'accepted'
    );
  $$;

  alter table ${SCHEMA}.invoice_items enable row level security;

  create policy invoice_items_select_member on ${SCHEMA}.invoice_items
    for select to authenticated
    using (${SCHEMA}.is_member(business_id));

  -- The view under test, identical in shape to the migration's.
  create or replace view ${SCHEMA}.invoice_item_discounts
  with (security_invoker = true)
  as
  select
    ii.id as invoice_item_id,
    ii.business_id,
    ii.invoice_id,
    ii.discount_percent_basis_points,
    ii.discount_paise,
    case
      when ii.discount_type <> 'none' then ii.discount_type
      when ii.discount_percent_basis_points > 0 then 'percent'::${SCHEMA}.discount_type
      else 'none'::${SCHEMA}.discount_type
    end as effective_discount_type,
    case
      when ii.discount_type <> 'none' then ii.discount_value
      when ii.discount_percent_basis_points > 0 then ii.discount_percent_basis_points::numeric(20,0)
      else 0::numeric(20,0)
    end as effective_discount_value
  from ${SCHEMA}.invoice_items ii;

  grant usage on schema ${SCHEMA} to authenticated;
  grant select on ${SCHEMA}.invoice_item_discounts to authenticated;
  grant select on ${SCHEMA}.invoice_items to authenticated;
  grant execute on function ${SCHEMA}.is_member(uuid) to authenticated;
`);

// --- Seed two tenants ------------------------------------------------------
const USER_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const BIZ_A = 'a0000000-0000-0000-0000-00000000000a';
const BIZ_B = 'b0000000-0000-0000-0000-00000000000b';

runQuery(`
  insert into ${SCHEMA}.business_members (business_id, user_id) values
    ('${BIZ_A}', '${USER_A}'),
    ('${BIZ_B}', '${USER_B}');

  insert into ${SCHEMA}.invoices (id, business_id) values
    ('a1000000-0000-0000-0000-000000000001', '${BIZ_A}'),
    ('b1000000-0000-0000-0000-000000000001', '${BIZ_B}');

  insert into ${SCHEMA}.invoice_items
    (id, business_id, invoice_id, discount_percent_basis_points, discount_paise)
  values
    ('a2000000-0000-0000-0000-000000000001', '${BIZ_A}', 'a1000000-0000-0000-0000-000000000001', 1000, 10000),
    ('b2000000-0000-0000-0000-000000000001', '${BIZ_B}', 'b1000000-0000-0000-0000-000000000001', 500,  2500);
`);

// --- Test as user A --------------------------------------------------------
console.log('AS USER A (member of business A only)');

const asA = runQuery(`
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"${USER_A}","role":"authenticated"}';
  select
    (select count(*)::int from ${SCHEMA}.invoice_item_discounts) as visible_rows,
    (select count(*)::int from ${SCHEMA}.invoice_item_discounts where business_id = '${BIZ_A}') as own_rows,
    (select count(*)::int from ${SCHEMA}.invoice_item_discounts where business_id = '${BIZ_B}') as other_rows;
`);
console.log(`  visible rows: ${asA[0]?.visible_rows} (expect 1)`);
console.log(`  own business rows: ${asA[0]?.own_rows} (expect 1)`);
console.log(`  other business rows: ${asA[0]?.other_rows} (expect 0)`);

// --- Test as user B --------------------------------------------------------
console.log('\nAS USER B (member of business B only)');

const asB = runQuery(`
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"${USER_B}","role":"authenticated"}';
  select
    (select count(*)::int from ${SCHEMA}.invoice_item_discounts) as visible_rows,
    (select count(*)::int from ${SCHEMA}.invoice_item_discounts where business_id = '${BIZ_B}') as own_rows,
    (select count(*)::int from ${SCHEMA}.invoice_item_discounts where business_id = '${BIZ_A}') as other_rows;
`);
console.log(`  visible rows: ${asB[0]?.visible_rows} (expect 1)`);
console.log(`  own business rows: ${asB[0]?.own_rows} (expect 1)`);
console.log(`  other business rows: ${asB[0]?.other_rows} (expect 0)`);

// --- Test as anon ----------------------------------------------------------
console.log('\nAS ANON');

const asAnon = runQuery(`
  set local role anon;
  set local request.jwt.claims = '{"role":"anon"}';
  select count(*)::int as visible_rows from ${SCHEMA}.invoice_item_discounts;
`);
console.log(`  visible rows: ${asAnon[0]?.visible_rows} (expect 0)`);

// --- Cleanup ---------------------------------------------------------------
runQuery(`drop schema ${SCHEMA} cascade;`);
console.log(`\nDropped schema ${SCHEMA}.`);

const pass =
  asA[0]?.visible_rows === 1 &&
  asA[0]?.other_rows === 0 &&
  asB[0]?.visible_rows === 1 &&
  asB[0]?.other_rows === 0 &&
  asAnon[0]?.visible_rows === 0;

console.log(`\n${pass ? 'RLS AND TENANT ISOLATION CONFIRMED' : 'RLS TEST FAILED'}`);
process.exit(pass ? 0 : 1);
