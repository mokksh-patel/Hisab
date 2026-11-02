/**
 * test-migration-0005.mjs — dry-run the migration logic in a throwaway schema.
 *
 * SAFETY: this never touches `public`. It creates a schema `mig_test`, builds
 * the pre-0005 table shapes, applies the migration's backfill logic, verifies
 * the result, then drops the schema.
 *
 * It does NOT execute the real migration file (which targets `public`). It
 * reproduces the specific statements that failed so the fix can be proven
 * without touching the live database.
 *
 * Usage: node scripts/test-migration-0005.mjs
 */

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN_REF = 'gdhaszmgwowfxgxllpva';
const SCHEMA = 'mig_test';

function runQuery(sql) {
  const tmp = join('backups', '.tmp-migtest.sql');
  writeFileSync(tmp, sql, 'utf8');
  const output = execSync(`npx --yes supabase db query --linked --output json --file "${tmp}"`, {
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 200 * 1024 * 1024,
  });
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  return JSON.parse(output.slice(start, end + 1));
}

// --- Safety ----------------------------------------------------------------
import { readFileSync } from 'node:fs';
const ref = readFileSync('supabase/.temp/project-ref', 'utf8').trim();
if (ref === FORBIDDEN_REF) {
  console.error(`REFUSING: linked project is production (${ref})`);
  process.exit(1);
}
console.log(`Migration logic test against ${ref} (schema: ${SCHEMA})\n`);

// --- Setup: reproduce the pre-0005 shape -----------------------------------
runQuery(`drop schema if exists ${SCHEMA} cascade;`);
runQuery(`create schema ${SCHEMA};`);

runQuery(`
  create table ${SCHEMA}.invoices (
    id uuid primary key,
    document_state text not null
  );
`);

runQuery(`
  create table ${SCHEMA}.invoice_items (
    id uuid primary key,
    invoice_id uuid not null references ${SCHEMA}.invoices (id),
    discount_percent_basis_points integer not null default 0,
    discount_paise numeric(20,0) not null default 0,
    taxable_amount_paise numeric(20,0) not null default 0,
    line_total_paise numeric(20,0) not null default 0
  );
`);

// The guard that caused the failure.
runQuery(`
  create or replace function ${SCHEMA}.guard_invoice_item_change()
  returns trigger language plpgsql as $$
  declare v_state text;
  begin
    select document_state into v_state
    from ${SCHEMA}.invoices where id = coalesce(new.invoice_id, old.invoice_id);
    if v_state is not null and v_state <> 'draft' then
      raise exception 'Line items of an issued invoice cannot be changed' using errcode = '22023';
    end if;
    return coalesce(new, old);
  end;
  $$;
`);

runQuery(`
  create trigger invoice_items_guard_change
    before insert or update or delete on ${SCHEMA}.invoice_items
    for each row execute function ${SCHEMA}.guard_invoice_item_change();
`);

// --- Prove the naive UPDATE fails ------------------------------------------
// The guard fires on the seed INSERT too, so the seed must run with the trigger
// disabled. We re-enable it immediately after seeding.
runQuery(`
  insert into ${SCHEMA}.invoices (id, document_state) values
    ('11111111-1111-1111-1111-111111111111', 'issued'),
    ('22222222-2222-2222-2222-222222222222', 'issued'),
    ('33333333-3333-3333-3333-333333333333', 'draft');
`);

runQuery(`alter table ${SCHEMA}.invoice_items disable trigger invoice_items_guard_change;`);

runQuery(`
  insert into ${SCHEMA}.invoice_items
    (id, invoice_id, discount_percent_basis_points, discount_paise, taxable_amount_paise, line_total_paise)
  values
    ('a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 0,    0,     500000, 590000),
    ('a0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 1000, 10000, 90000,  106200),
    ('a0000000-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222222', 500,  2500,  47500,  56050),
    ('a0000000-0000-0000-0000-000000000004', '33333333-3333-3333-3333-333333333333', 0,    0,     10000,  11800);
`);

runQuery(`alter table ${SCHEMA}.invoice_items enable trigger invoice_items_guard_change;`);

const before = runQuery(`
  select
    count(*)::int as items,
    sum(taxable_amount_paise)::text as taxable,
    sum(line_total_paise)::text as total,
    sum(discount_paise)::text as discount
  from ${SCHEMA}.invoice_items;
`);
console.log('BEFORE backfill:', JSON.stringify(before[0]));

let naiveFailed = false;
try {
  runQuery(`
    update ${SCHEMA}.invoice_items
    set discount_percent_basis_points = discount_percent_basis_points
    where invoice_id = '11111111-1111-1111-1111-111111111111';
  `);
} catch (error) {
  naiveFailed = true;
  console.log('CONFIRMED: a plain UPDATE on issued items is rejected by the guard');
}

if (!naiveFailed) {
  console.error('UNEXPECTED: the guard did not reject the update');
  runQuery(`drop schema ${SCHEMA} cascade;`);
  process.exit(1);
}

// --- Apply the migration's backfill logic ----------------------------------
runQuery(`
  alter table ${SCHEMA}.invoice_items add column discount_type text not null default 'none';
  alter table ${SCHEMA}.invoice_items add column discount_value numeric(20,0) not null default 0;
`);

runQuery(`
  do $$
  declare v_pending integer;
  begin
    select count(*) into v_pending
    from ${SCHEMA}.invoice_items
    where discount_type = 'none' and discount_value = 0;

    if v_pending = 0 then
      raise notice 'nothing to do';
      return;
    end if;

    alter table ${SCHEMA}.invoice_items disable trigger invoice_items_guard_change;

    begin
      update ${SCHEMA}.invoice_items
      set discount_type = case
            when discount_percent_basis_points > 0 then 'percent'
            else 'none'
          end,
          discount_value = discount_percent_basis_points
      where discount_type = 'none' and discount_value = 0;
    exception
      when others then
        alter table ${SCHEMA}.invoice_items enable trigger invoice_items_guard_change;
        raise;
    end;

    alter table ${SCHEMA}.invoice_items enable trigger invoice_items_guard_change;
  end;
  $$;
`);

// --- Verify ----------------------------------------------------------------
const after = runQuery(`
  select
    count(*)::int as items,
    sum(taxable_amount_paise)::text as taxable,
    sum(line_total_paise)::text as total,
    sum(discount_paise)::text as discount
  from ${SCHEMA}.invoice_items;
`);
console.log('AFTER  backfill:', JSON.stringify(after[0]));

const mapping = runQuery(`
  select discount_percent_basis_points as bp, discount_type, discount_value::text as val
  from ${SCHEMA}.invoice_items order by discount_percent_basis_points;
`);
console.log('\nDISCOUNT MAPPING:');
for (const row of mapping) {
  console.log(`  bp=${row.bp} -> type=${row.discount_type} value=${row.val}`);
}

const triggerState = runQuery(`
  select tgenabled from pg_trigger
  where tgname = 'invoice_items_guard_change'
    and tgrelid = '${SCHEMA}.invoice_items'::regclass;
`);
console.log(`\nTRIGGER STATE AFTER: ${triggerState[0]?.tgenabled} (O = enabled)`);

// Guard must still reject updates to issued items.
let guardStillWorks = false;
try {
  runQuery(`
    update ${SCHEMA}.invoice_items set discount_value = 999
    where invoice_id = '11111111-1111-1111-1111-111111111111';
  `);
} catch {
  guardStillWorks = true;
}
console.log(`GUARD STILL BLOCKS ISSUED ITEMS: ${guardStillWorks}`);

// Draft items must still be editable.
let draftEditable = true;
try {
  runQuery(`
    update ${SCHEMA}.invoice_items set discount_value = 0
    where invoice_id = '33333333-3333-3333-3333-333333333333';
  `);
} catch {
  draftEditable = false;
}
console.log(`DRAFT ITEMS STILL EDITABLE: ${draftEditable}`);

// --- Cleanup ---------------------------------------------------------------
runQuery(`drop schema ${SCHEMA} cascade;`);
console.log(`\nDropped schema ${SCHEMA}.`);

const financialsUnchanged =
  before[0].taxable === after[0].taxable &&
  before[0].total === after[0].total &&
  before[0].discount === after[0].discount;

console.log(`\nFINANCIALS UNCHANGED: ${financialsUnchanged}`);
console.log(`TRIGGER RESTORED: ${triggerState[0]?.tgenabled === 'O'}`);
console.log(`GUARD INTACT: ${guardStillWorks}`);
console.log(`DRAFT EDITABLE: ${draftEditable}`);

const pass = financialsUnchanged && triggerState[0]?.tgenabled === 'O' && guardStillWorks && draftEditable;
console.log(`\n${pass ? 'ALL CHECKS PASSED' : 'CHECKS FAILED'}`);
process.exit(pass ? 0 : 1);
