/**
 * test-gst-scheme-workflow.mjs — verify the explicit GST scheme workflow.
 *
 * Proves:
 *   1. Explicit 'regular' -> registered, no review flag.
 *   2. Explicit 'composition' -> registered, no review flag.
 *   3. Explicit 'unregistered' -> not registered, no review flag.
 *   4. Legacy call (no scheme) + registered -> flagged for review.
 *   5. Legacy call (no scheme) + not registered -> unregistered, no review.
 *   6. A flagged business cannot issue a tax invoice.
 *   7. Confirming the scheme clears the flag and unblocks invoicing.
 *   8. Composition can never issue a tax invoice, even after confirmation.
 *
 * SAFETY: schema `gst_test`, dropped afterwards.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN_REF = 'gdhaszmgwowfxgxllpva';
const SCHEMA = 'gst_test';

function runQuery(sql) {
  const tmp = join('backups', '.tmp-gst.sql');
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
console.log(`GST scheme workflow test against ${ref}\n`);

runQuery(`drop schema if exists ${SCHEMA} cascade;`);
runQuery(`create schema ${SCHEMA};`);

// --- Reproduce the schema + the new function logic -------------------------
runQuery(`
  create type ${SCHEMA}.gst_scheme as enum ('unregistered', 'regular', 'composition');

  create table ${SCHEMA}.businesses (
    id uuid primary key default gen_random_uuid(),
    legal_name text not null,
    display_name text not null,
    is_gst_registered boolean not null default false,
    gst_scheme ${SCHEMA}.gst_scheme default 'unregistered',
    gst_scheme_needs_review boolean not null default false
  );

  alter table ${SCHEMA}.businesses
    add constraint businesses_gst_scheme_registration_consistent
    check (
      (gst_scheme = 'unregistered' and is_gst_registered = false)
      or (gst_scheme = 'regular' and is_gst_registered = true)
      or (gst_scheme = 'composition' and is_gst_registered = true)
    );

  -- Mirrors the migration's create_business_with_owner() scheme logic.
  create or replace function ${SCHEMA}.create_business(
    p_legal_name text,
    p_is_gst_registered boolean default false,
    p_gst_scheme ${SCHEMA}.gst_scheme default null
  ) returns uuid language plpgsql as $$
  declare
    v_id uuid;
    v_scheme ${SCHEMA}.gst_scheme;
    v_registered boolean;
    v_needs_review boolean;
  begin
    if p_gst_scheme is not null then
      v_scheme := p_gst_scheme;
      v_registered := (p_gst_scheme <> 'unregistered');
      v_needs_review := false;
    else
      if coalesce(p_is_gst_registered, false) then
        v_scheme := 'regular';
        v_registered := true;
        v_needs_review := true;
      else
        v_scheme := 'unregistered';
        v_registered := false;
        v_needs_review := false;
      end if;
    end if;

    insert into ${SCHEMA}.businesses (legal_name, display_name, is_gst_registered, gst_scheme, gst_scheme_needs_review)
    values (p_legal_name, p_legal_name, v_registered, v_scheme, v_needs_review)
    returning id into v_id;
    return v_id;
  end;
  $$;

  -- Mirrors the create_invoice() scheme guard.
  create or replace function ${SCHEMA}.assert_can_issue_tax_invoice(p_business_id uuid)
  returns void language plpgsql as $$
  declare v_b ${SCHEMA}.businesses%rowtype;
  begin
    select * into v_b from ${SCHEMA}.businesses where id = p_business_id;
    if coalesce(v_b.gst_scheme_needs_review, false) then
      raise exception 'GST scheme not confirmed' using errcode = '22023';
    end if;
    if v_b.gst_scheme = 'composition' then
      raise exception 'Composition business cannot issue a tax invoice' using errcode = '22023';
    end if;
    if v_b.gst_scheme = 'unregistered' then
      raise exception 'Unregistered business cannot charge GST' using errcode = '22023';
    end if;
  end;
  $$;

  create or replace function ${SCHEMA}.confirm_scheme(p_business_id uuid, p_scheme ${SCHEMA}.gst_scheme)
  returns void language plpgsql as $$
  begin
    update ${SCHEMA}.businesses
    set gst_scheme = p_scheme,
        is_gst_registered = (p_scheme <> 'unregistered'),
        gst_scheme_needs_review = false
    where id = p_business_id;
  end;
  $$;
`);

// --- Test 1-3: explicit schemes --------------------------------------------
console.log('TEST 1-3: explicit scheme selection');

runQuery(`
  select ${SCHEMA}.create_business('Explicit Regular', true, 'regular');
  select ${SCHEMA}.create_business('Explicit Composition', true, 'composition');
  select ${SCHEMA}.create_business('Explicit Unregistered', false, 'unregistered');
`);

const explicit = runQuery(`
  select legal_name, is_gst_registered, gst_scheme::text as scheme, gst_scheme_needs_review
  from ${SCHEMA}.businesses order by legal_name;
`);
for (const row of explicit) {
  console.log(
    `  ${row.legal_name.padEnd(24)} registered=${String(row.is_gst_registered).padEnd(5)} scheme=${row.scheme.padEnd(12)} review=${row.gst_scheme_needs_review}`,
  );
}

// --- Test 4-5: legacy calls ------------------------------------------------
console.log('\nTEST 4-5: legacy call without a scheme');

runQuery(`
  select ${SCHEMA}.create_business('Legacy Registered', true, null);
  select ${SCHEMA}.create_business('Legacy Unregistered', false, null);
`);

const legacy = runQuery(`
  select legal_name, is_gst_registered, gst_scheme::text as scheme, gst_scheme_needs_review
  from ${SCHEMA}.businesses
  where legal_name like 'Legacy%' order by legal_name;
`);
for (const row of legacy) {
  console.log(
    `  ${row.legal_name.padEnd(24)} registered=${String(row.is_gst_registered).padEnd(5)} scheme=${row.scheme.padEnd(12)} review=${row.gst_scheme_needs_review}`,
  );
}

// --- Test 6: flagged business cannot invoice -------------------------------
console.log('\nTEST 6: a flagged business cannot issue a tax invoice');
const legacyReg = runQuery(`
  select id from ${SCHEMA}.businesses where legal_name = 'Legacy Registered';
`)[0]?.id;

let flaggedBlocked = false;
try {
  runQuery(`select ${SCHEMA}.assert_can_issue_tax_invoice('${legacyReg}');`);
} catch {
  flaggedBlocked = true;
}
console.log(`  blocked: ${flaggedBlocked} (expect true)`);

// --- Test 7: confirmation unblocks -----------------------------------------
console.log('\nTEST 7: confirming the scheme unblocks invoicing');
runQuery(`select ${SCHEMA}.confirm_scheme('${legacyReg}', 'regular');`);

const afterConfirm = runQuery(`
  select gst_scheme::text as scheme, gst_scheme_needs_review
  from ${SCHEMA}.businesses where id = '${legacyReg}';
`);
console.log(`  scheme=${afterConfirm[0]?.scheme} review=${afterConfirm[0]?.gst_scheme_needs_review}`);

let unblocked = true;
try {
  runQuery(`select ${SCHEMA}.assert_can_issue_tax_invoice('${legacyReg}');`);
} catch {
  unblocked = false;
}
console.log(`  can now invoice: ${unblocked} (expect true)`);

// --- Test 8: composition never invoices ------------------------------------
console.log('\nTEST 8: composition cannot invoice even after confirmation');
const comp = runQuery(`
  select id from ${SCHEMA}.businesses where legal_name = 'Explicit Composition';
`)[0]?.id;

let compBlocked = false;
try {
  runQuery(`select ${SCHEMA}.assert_can_issue_tax_invoice('${comp}');`);
} catch {
  compBlocked = true;
}
console.log(`  blocked: ${compBlocked} (expect true)`);

// --- Cleanup ---------------------------------------------------------------
runQuery(`drop schema ${SCHEMA} cascade;`);
console.log(`\nDropped schema ${SCHEMA}.`);

const pass =
  explicit.length === 3 &&
  explicit.every((r) => r.gst_scheme_needs_review === false) &&
  legacy.find((r) => r.legal_name === 'Legacy Registered')?.gst_scheme_needs_review === true &&
  legacy.find((r) => r.legal_name === 'Legacy Unregistered')?.gst_scheme_needs_review === false &&
  flaggedBlocked &&
  unblocked &&
  compBlocked;

console.log(`\n${pass ? 'GST SCHEME WORKFLOW CONFIRMED' : 'TEST FAILED'}`);
process.exit(pass ? 0 : 1);
