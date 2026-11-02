/**
 * test-migration-0005.mjs — validate the 0005 backfill strategy in a throwaway
 * schema.
 *
 * SAFETY: never touches `public`. Creates schema `mig_test`, reproduces the
 * pre-0005 shape, applies the migration's backfill logic, verifies, then drops.
 *
 * It proves the chosen approach: draft items are updated, issued items are left
 * untouched and read through a fallback view, and the immutability guard is
 * never disabled.
 *
 * Usage: node scripts/test-migration-0005.mjs
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
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

const ref = readFileSync('supabase/.temp/project-ref', 'utf8').trim();
if (ref === FORBIDDEN_REF) {
  console.error(`REFUSING: linked project is production (${ref})`);
  process.exit(1);
}
console.log(`Migration logic test against ${ref} (schema: ${SCHEMA})\n`);

// --- Setup -----------------------------------------------------------------
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
    business_id uuid not null,
    invoice_id uuid not null references ${SCHEMA}.invoices (id),
    discount_percent_basis_points integer not null default 0,
    discount_paise numeric(20,0) not null default 0,
    taxable_amount_paise numeric(20,0) not null default 0,
    line_total_paise numeric(20,0) not null default 0
  );
`);

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

// --- Seed ------------------------------------------------------------------
runQuery(`
  insert into ${SCHEMA}.invoices (id, document_state) values
    ('11111111-1111-1111-1111-111111111111', 'issued'),
    ('22222222-2222-2222-2222-222222222222', 'issued'),
    ('33333333-3333-3333-3333-333333333333', 'draft');
`);

// Seed with the guard disabled (it also blocks INSERT into issued invoices).
runQuery(`alter table ${SCHEMA}.invoice_items disable trigger invoice_items_guard_change;`);
runQuery(`
  insert into ${SCHEMA}.invoice_items
    (id, business_id, invoice_id, discount_percent_basis_points, discount_paise, taxable_amount_paise, line_total_paise)
  values
    ('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 0,    0,     500000, 590000),
    ('a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 1000, 10000, 90000,  106200),
    ('a0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 500,  2500,  47500,  56050),
    ('a0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 1000, 1000,  9000,   10620);
`);
runQuery(`alter table ${SCHEMA}.invoice_items enable trigger invoice_items_guard_change;`);

const before = runQuery(`
  select count(*)::int as items,
         sum(taxable_amount_paise)::text as taxable,
         sum(line_total_paise)::text as total,
         sum(discount_paise)::text as discount
  from ${SCHEMA}.invoice_items;
`);
console.log('BEFORE:', JSON.stringify(before[0]));

// --- Apply the migration's approach ----------------------------------------
runQuery(`
  alter table ${SCHEMA}.invoice_items add column discount_type text not null default 'none';
  alter table ${SCHEMA}.invoice_items add column discount_value numeric(20,0) not null default 0;
`);

// 1. Draft items only — the guard permits this.
runQuery(`
  update ${SCHEMA}.invoice_items ii
  set discount_type = case
        when ii.discount_percent_basis_points > 0 then 'percent'
        else 'none'
      end,
      discount_value = ii.discount_percent_basis_points
  from ${SCHEMA}.invoices i
  where i.id = ii.invoice_id
    and i.document_state = 'draft'
    and ii.discount_type = 'none'
    and ii.discount_value = 0;
`);

// 2. Fallback view for issued items.
runQuery(`
  create or replace view ${SCHEMA}.invoice_item_discounts as
  select
    ii.id as invoice_item_id,
    ii.business_id,
    ii.invoice_id,
    ii.discount_percent_basis_points,
    ii.discount_paise,
    case
      when ii.discount_type <> 'none' then ii.discount_type
      when ii.discount_percent_basis_points > 0 then 'percent'
      else 'none'
    end as effective_discount_type,
    case
      when ii.discount_type <> 'none' then ii.discount_value
      when ii.discount_percent_basis_points > 0 then ii.discount_percent_basis_points::numeric(20,0)
      else 0::numeric(20,0)
    end as effective_discount_value
  from ${SCHEMA}.invoice_items ii;
`);

// --- Verify ----------------------------------------------------------------
const after = runQuery(`
  select count(*)::int as items,
         sum(taxable_amount_paise)::text as taxable,
         sum(line_total_paise)::text as total,
         sum(discount_paise)::text as discount
  from ${SCHEMA}.invoice_items;
`);
console.log('AFTER: ', JSON.stringify(after[0]));

const effective = runQuery(`
  select d.invoice_item_id, i.document_state,
         d.discount_percent_basis_points as bp,
         d.effective_discount_type as eff_type,
         d.effective_discount_value::text as eff_val
  from ${SCHEMA}.invoice_item_discounts d
  join ${SCHEMA}.invoices i on i.id = d.invoice_id
  order by d.invoice_item_id;
`);
console.log('\nEFFECTIVE DISCOUNT (via view):');
for (const row of effective) {
  console.log(
    `  ${row.document_state.padEnd(6)} bp=${String(row.bp).padStart(4)} -> ${row.eff_type.padEnd(7)} value=${row.eff_val}`,
  );
}

const triggerState = runQuery(`
  select tgenabled from pg_trigger
  where tgname = 'invoice_items_guard_change'
    and tgrelid = '${SCHEMA}.invoice_items'::regclass;
`);
console.log(`\nTRIGGER STATE: ${triggerState[0]?.tgenabled} (O = enabled)`);

// Guard must still block issued items.
let guardBlocks = false;
try {
  runQuery(`
    update ${SCHEMA}.invoice_items set discount_value = 999
    where invoice_id = '11111111-1111-1111-1111-111111111111';
  `);
} catch {
  guardBlocks = true;
}
console.log(`GUARD BLOCKS ISSUED ITEMS: ${guardBlocks}`);

// Draft items must still be editable.
let draftEditable = true;
try {
  runQuery(`
    update ${SCHEMA}.invoice_items set discount_value = 1000
    where invoice_id = '33333333-3333-3333-3333-333333333333';
  `);
} catch {
  draftEditable = false;
}
console.log(`DRAFT ITEMS EDITABLE: ${draftEditable}`);

// Issued items must be byte-identical to before.
const issuedUnchanged = runQuery(`
  select count(*)::int as n
  from ${SCHEMA}.invoice_items ii
  join ${SCHEMA}.invoices i on i.id = ii.invoice_id
  where i.document_state <> 'draft'
    and ii.discount_type = 'none'
    and ii.discount_value = 0;
`);
console.log(`ISSUED ITEMS UNTOUCHED: ${issuedUnchanged[0]?.n === 3} (${issuedUnchanged[0]?.n} of 3)`);

// --- Cleanup ---------------------------------------------------------------
runQuery(`drop schema ${SCHEMA} cascade;`);
console.log(`\nDropped schema ${SCHEMA}.`);

const financialsUnchanged =
  before[0].taxable === after[0].taxable &&
  before[0].total === after[0].total &&
  before[0].discount === after[0].discount;

const pass =
  financialsUnchanged &&
  triggerState[0]?.tgenabled === 'O' &&
  guardBlocks &&
  draftEditable &&
  issuedUnchanged[0]?.n === 3;

console.log(`\nFINANCIALS UNCHANGED: ${financialsUnchanged}`);
console.log(`TRIGGER ENABLED: ${triggerState[0]?.tgenabled === 'O'}`);
console.log(`GUARD INTACT: ${guardBlocks}`);
console.log(`DRAFT EDITABLE: ${draftEditable}`);
console.log(`ISSUED UNTOUCHED: ${issuedUnchanged[0]?.n === 3}`);
console.log(`\n${pass ? 'ALL CHECKS PASSED' : 'CHECKS FAILED'}`);
process.exit(pass ? 0 : 1);
