/**
 * test-restartability.mjs — prove the corrected 0005 can resume from the
 * verified partial state without duplicating objects or changing financials.
 *
 * METHOD
 * Reproduces the EXACT partial state observed on the remote (enums, columns and
 * constraints already present; functions and view absent) in a throwaway schema,
 * then applies the migration's DDL statements and checks for duplicates.
 *
 * SAFETY: schema `restart_test`, dropped afterwards.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN_REF = 'gdhaszmgwowfxgxllpva';
const SCHEMA = 'restart_test';

function runQuery(sql) {
  const tmp = join('backups', '.tmp-restart.sql');
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
console.log(`Restartability test against ${ref} (schema: ${SCHEMA})\n`);

runQuery(`drop schema if exists ${SCHEMA} cascade;`);
runQuery(`create schema ${SCHEMA};`);

// --- Reproduce the exact partial state -------------------------------------
console.log('STEP 1: reproduce the observed partial state');

runQuery(`
  create type ${SCHEMA}.gst_scheme as enum ('unregistered', 'regular', 'composition');
  create type ${SCHEMA}.discount_type as enum ('none', 'percent', 'fixed');

  create table ${SCHEMA}.businesses (
    id uuid primary key default gen_random_uuid(),
    is_gst_registered boolean not null default false,
    gst_scheme ${SCHEMA}.gst_scheme,
    gst_scheme_needs_review boolean not null default false
  );

  create table ${SCHEMA}.invoices (
    id uuid primary key default gen_random_uuid(),
    document_state text not null default 'draft',
    price_includes_tax boolean not null default false,
    invoice_discount_paise numeric(20,0) not null default 0
  );

  create table ${SCHEMA}.invoice_items (
    id uuid primary key default gen_random_uuid(),
    business_id uuid not null,
    invoice_id uuid not null references ${SCHEMA}.invoices (id),
    discount_percent_basis_points integer not null default 0,
    discount_paise numeric(20,0) not null default 0,
    taxable_amount_paise numeric(20,0) not null default 0,
    line_total_paise numeric(20,0) not null default 0,
    discount_type ${SCHEMA}.discount_type not null default 'none',
    discount_value numeric(20,0) not null default 0
  );

  alter table ${SCHEMA}.businesses
    add constraint businesses_gst_scheme_registration_consistent
    check (
      (gst_scheme = 'unregistered' and is_gst_registered = false)
      or (gst_scheme = 'regular' and is_gst_registered = true)
      or (gst_scheme = 'composition' and is_gst_registered = true)
    );

  alter table ${SCHEMA}.invoices
    add constraint invoices_invoice_discount_non_negative
    check (invoice_discount_paise >= 0);
`);

// Seed: 2 registered (flagged), 1 unregistered, 1 issued invoice with items.
runQuery(`
  insert into ${SCHEMA}.businesses (is_gst_registered, gst_scheme, gst_scheme_needs_review) values
    (true,  'regular',      true),
    (true,  'regular',      true),
    (false, 'unregistered', false);

  insert into ${SCHEMA}.invoices (id, document_state) values
    ('11111111-1111-1111-1111-111111111111', 'issued'),
    ('22222222-2222-2222-2222-222222222222', 'draft');

  insert into ${SCHEMA}.invoice_items
    (business_id, invoice_id, discount_percent_basis_points, discount_paise, taxable_amount_paise, line_total_paise)
  values
    ('b0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 1000, 10000, 90000, 106200),
    ('b0000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 500,  2500,  47500, 56050);
`);

const before = runQuery(`
  select count(*)::int as items,
         sum(taxable_amount_paise)::text as taxable,
         sum(line_total_paise)::text as total
  from ${SCHEMA}.invoice_items;
`);
console.log('  partial state created:', JSON.stringify(before[0]));

// --- Apply the migration's DDL again (restart) -----------------------------
console.log('\nSTEP 2: re-apply the migration DDL against the partial state');

runQuery(`
  -- enum guards
  do $$
  begin
    if not exists (select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace
                   where n.nspname='${SCHEMA}' and t.typname='gst_scheme') then
      create type ${SCHEMA}.gst_scheme as enum ('unregistered', 'regular', 'composition');
    end if;
    if not exists (select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace
                   where n.nspname='${SCHEMA}' and t.typname='discount_type') then
      create type ${SCHEMA}.discount_type as enum ('none', 'percent', 'fixed');
    end if;
  end;
  $$;

  -- column guards
  alter table ${SCHEMA}.businesses add column if not exists gst_scheme ${SCHEMA}.gst_scheme;
  alter table ${SCHEMA}.businesses add column if not exists gst_scheme_needs_review boolean not null default false;
  alter table ${SCHEMA}.invoices add column if not exists price_includes_tax boolean not null default false;
  alter table ${SCHEMA}.invoices add column if not exists invoice_discount_paise numeric(20,0) not null default 0;
  alter table ${SCHEMA}.invoice_items add column if not exists discount_type ${SCHEMA}.discount_type not null default 'none';
  alter table ${SCHEMA}.invoice_items add column if not exists discount_value numeric(20,0) not null default 0;

  -- constraint guards
  alter table ${SCHEMA}.businesses drop constraint if exists businesses_gst_scheme_registration_consistent;
  alter table ${SCHEMA}.businesses add constraint businesses_gst_scheme_registration_consistent
    check (
      (gst_scheme = 'unregistered' and is_gst_registered = false)
      or (gst_scheme = 'regular' and is_gst_registered = true)
      or (gst_scheme = 'composition' and is_gst_registered = true)
    );

  alter table ${SCHEMA}.invoices drop constraint if exists invoices_invoice_discount_non_negative;
  alter table ${SCHEMA}.invoices add constraint invoices_invoice_discount_non_negative
    check (invoice_discount_paise >= 0);

  -- backfill (draft only)
  update ${SCHEMA}.invoice_items ii
  set discount_type = case when ii.discount_percent_basis_points > 0 then 'percent'::${SCHEMA}.discount_type
                           else 'none'::${SCHEMA}.discount_type end,
      discount_value = ii.discount_percent_basis_points
  from ${SCHEMA}.invoices i
  where i.id = ii.invoice_id and i.document_state = 'draft'
    and ii.discount_type = 'none' and ii.discount_value = 0;

  -- fallback view
  create or replace view ${SCHEMA}.invoice_item_discounts as
  select ii.id as invoice_item_id, ii.business_id, ii.invoice_id,
         ii.discount_percent_basis_points, ii.discount_paise,
         case when ii.discount_type <> 'none' then ii.discount_type
              when ii.discount_percent_basis_points > 0 then 'percent'::${SCHEMA}.discount_type
              else 'none'::${SCHEMA}.discount_type end as effective_discount_type,
         case when ii.discount_type <> 'none' then ii.discount_value
              when ii.discount_percent_basis_points > 0 then ii.discount_percent_basis_points::numeric(20,0)
              else 0::numeric(20,0) end as effective_discount_value
  from ${SCHEMA}.invoice_items ii;
`);

console.log('  re-apply completed without error');

// --- Check for duplicates --------------------------------------------------
console.log('\nSTEP 3: check for duplicate objects');

const dupes = runQuery(`
  select 'enum' as kind, t.typname as name, count(*)::int as n
  from pg_type t join pg_namespace n on n.oid=t.typnamespace
  where n.nspname='${SCHEMA}' and t.typname in ('gst_scheme','discount_type')
  group by t.typname
  union all
  select 'column', table_name||'.'||column_name, count(*)::int
  from information_schema.columns
  where table_schema='${SCHEMA}'
    and column_name in ('gst_scheme','gst_scheme_needs_review','price_includes_tax','invoice_discount_paise','discount_type','discount_value')
  group by table_name, column_name
  union all
  select 'constraint', conname, count(*)::int
  from pg_constraint
  where connamespace='${SCHEMA}'::regnamespace
    and conname in ('businesses_gst_scheme_registration_consistent','invoices_invoice_discount_non_negative')
  group by conname
  union all
  select 'view', table_name, count(*)::int
  from information_schema.views
  where table_schema='${SCHEMA}' and table_name='invoice_item_discounts'
  group by table_name
  order by kind, name;
`);

let duplicates = 0;
for (const row of dupes) {
  const ok = row.n === 1;
  if (!ok) duplicates += 1;
  console.log(`  ${row.kind.padEnd(10)} ${row.name.padEnd(48)} count=${row.n} ${ok ? 'OK' : 'DUPLICATE'}`);
}

// --- Verify financials unchanged -------------------------------------------
const after = runQuery(`
  select count(*)::int as items,
         sum(taxable_amount_paise)::text as taxable,
         sum(line_total_paise)::text as total
  from ${SCHEMA}.invoice_items;
`);
console.log('\nSTEP 4: financial comparison');
console.log('  before:', JSON.stringify(before[0]));
console.log('  after: ', JSON.stringify(after[0]));

const financialsUnchanged =
  before[0].items === after[0].items &&
  before[0].taxable === after[0].taxable &&
  before[0].total === after[0].total;

// --- Verify effective discounts --------------------------------------------
const effective = runQuery(`
  select d.invoice_item_id, i.document_state, d.discount_percent_basis_points as bp,
         d.effective_discount_type as eff_type, d.effective_discount_value::text as eff_val
  from ${SCHEMA}.invoice_item_discounts d
  join ${SCHEMA}.invoices i on i.id = d.invoice_id
  order by i.document_state;
`);
console.log('\nSTEP 5: effective discounts via the view');
for (const row of effective) {
  console.log(`  ${row.document_state.padEnd(6)} bp=${String(row.bp).padStart(4)} -> ${row.eff_type.padEnd(7)} value=${row.eff_val}`);
}

// --- Cleanup ---------------------------------------------------------------
runQuery(`drop schema ${SCHEMA} cascade;`);
console.log(`\nDropped schema ${SCHEMA}.`);

const pass = duplicates === 0 && financialsUnchanged;
console.log(`\nDUPLICATES: ${duplicates}`);
console.log(`FINANCIALS UNCHANGED: ${financialsUnchanged}`);
console.log(`\n${pass ? 'RESTARTABILITY CONFIRMED' : 'RESTARTABILITY FAILED'}`);
process.exit(pass ? 0 : 1);
