/**
 * test-business-creation.mjs — prove create_business_with_owner() satisfies the
 * gst_scheme consistency constraint for both registered and unregistered
 * businesses.
 *
 * This reproduces the regression found when running the Playwright suite against
 * the partially-migrated database: the constraint existed but the function did
 * not set gst_scheme, so every GST-registered signup failed.
 *
 * SAFETY: schema `biz_test`, dropped afterwards.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN_REF = 'gdhaszmgwowfxgxllpva';
const SCHEMA = 'biz_test';

function runQuery(sql) {
  const tmp = join('backups', '.tmp-biz.sql');
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
console.log(`Business creation constraint test against ${ref}\n`);

runQuery(`drop schema if exists ${SCHEMA} cascade;`);
runQuery(`create schema ${SCHEMA};`);

// --- Reproduce the constraint ----------------------------------------------
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
`);

// --- Test 1: the OLD insert (no gst_scheme) must fail ----------------------
console.log('TEST 1: old insert without gst_scheme, is_gst_registered = true');
let oldFails = false;
try {
  runQuery(`
    insert into ${SCHEMA}.businesses (legal_name, display_name, is_gst_registered)
    values ('Old Co', 'Old Co', true);
  `);
} catch {
  oldFails = true;
}
console.log(`  rejected by constraint: ${oldFails} (expect true)`);

// --- Test 2: the NEW insert (with gst_scheme) must succeed -----------------
console.log('\nTEST 2: new insert with gst_scheme derived from the flag');

runQuery(`
  insert into ${SCHEMA}.businesses (legal_name, display_name, is_gst_registered, gst_scheme, gst_scheme_needs_review)
  values
    ('Registered Co', 'Registered Co', true,  'regular',      false),
    ('Unregistered Co', 'Unregistered Co', false, 'unregistered', false);
`);

const rows = runQuery(`
  select legal_name, is_gst_registered, gst_scheme::text as scheme, gst_scheme_needs_review
  from ${SCHEMA}.businesses order by legal_name;
`);
for (const row of rows) {
  console.log(
    `  ${row.legal_name.padEnd(18)} registered=${String(row.is_gst_registered).padEnd(5)} scheme=${row.scheme.padEnd(12)} review=${row.gst_scheme_needs_review}`,
  );
}

// --- Test 3: composition must be registered --------------------------------
console.log('\nTEST 3: composition with is_gst_registered = false must be rejected');
let compFails = false;
try {
  runQuery(`
    insert into ${SCHEMA}.businesses (legal_name, display_name, is_gst_registered, gst_scheme)
    values ('Bad Comp', 'Bad Comp', false, 'composition');
  `);
} catch {
  compFails = true;
}
console.log(`  rejected by constraint: ${compFails} (expect true)`);

// --- Cleanup ---------------------------------------------------------------
runQuery(`drop schema ${SCHEMA} cascade;`);
console.log(`\nDropped schema ${SCHEMA}.`);

const pass = oldFails && rows.length === 2 && compFails;
console.log(`\n${pass ? 'CONSTRAINT INTERACTION CONFIRMED' : 'TEST FAILED'}`);
process.exit(pass ? 0 : 1);
