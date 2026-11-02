/**
 * test-cli-transaction.mjs — determine empirically whether `supabase db push`
 * wraps a migration file in a single transaction.
 *
 * METHOD
 *   We cannot run `db push` (forbidden). Instead we reproduce what the CLI does:
 *   send a multi-statement script through the same Management API endpoint that
 *   `db query --file` uses, with a deliberate failure in the middle, and observe
 *   whether the earlier statements persisted.
 *
 *   This tells us whether the transport is transactional. It does NOT prove what
 *   `db push` does internally — that is stated separately as a limitation.
 *
 * SAFETY: uses schema `tx_test`, dropped afterwards. Never touches `public`.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN_REF = 'gdhaszmgwowfxgxllpva';
const SCHEMA = 'tx_test';

function runFile(sql) {
  const tmp = join('backups', '.tmp-tx.sql');
  writeFileSync(tmp, sql, 'utf8');
  try {
    const output = execSync(`npx --yes supabase db query --linked --output json --file "${tmp}"`, {
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 50 * 1024 * 1024,
    });
    return { ok: true, output };
  } catch (error) {
    return { ok: false, output: String(error.stdout ?? '') + String(error.stderr ?? '') };
  }
}

function runQuery(sql) {
  const tmp = join('backups', '.tmp-txq.sql');
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
console.log(`CLI transaction behaviour test against ${ref}\n`);

runQuery(`drop schema if exists ${SCHEMA} cascade;`);
runQuery(`create schema ${SCHEMA};`);

// --- Test 1: multi-statement script WITHOUT explicit BEGIN/COMMIT ----------
console.log('TEST 1: multi-statement script, no explicit BEGIN/COMMIT, fails midway');

const script1 = `
create table ${SCHEMA}.t1 (id int);
insert into ${SCHEMA}.t1 values (1);
select 1 / 0;
insert into ${SCHEMA}.t1 values (2);
`;

const r1 = runFile(script1);
console.log(`  script result: ${r1.ok ? 'succeeded' : 'failed (expected)'}`);

const t1Exists = runQuery(`
  select count(*)::int as n from information_schema.tables
  where table_schema='${SCHEMA}' and table_name='t1';
`);
const t1Rows = t1Exists[0]?.n
  ? runQuery(`select count(*)::int as n from ${SCHEMA}.t1;`)[0]?.n
  : null;

console.log(`  table t1 exists after failure: ${t1Exists[0]?.n === 1}`);
console.log(`  rows in t1 after failure: ${t1Rows ?? 'n/a'}`);
console.log(
  `  => transport is ${t1Exists[0]?.n === 1 ? 'NOT transactional (DDL persisted)' : 'transactional (rolled back)'}`,
);

// --- Test 2: same script WITH explicit BEGIN/COMMIT ------------------------
console.log('\nTEST 2: same script with explicit BEGIN/COMMIT');

runQuery(`drop table if exists ${SCHEMA}.t1;`);

const script2 = `
begin;
create table ${SCHEMA}.t2 (id int);
insert into ${SCHEMA}.t2 values (1);
select 1 / 0;
insert into ${SCHEMA}.t2 values (2);
commit;
`;

const r2 = runFile(script2);
console.log(`  script result: ${r2.ok ? 'succeeded' : 'failed (expected)'}`);

const t2Exists = runQuery(`
  select count(*)::int as n from information_schema.tables
  where table_schema='${SCHEMA}' and table_name='t2';
`);
console.log(`  table t2 exists after failure: ${t2Exists[0]?.n === 1}`);
console.log(
  `  => explicit BEGIN/COMMIT ${t2Exists[0]?.n === 1 ? 'did NOT roll back' : 'DID roll back'}`,
);

// --- Cleanup ---------------------------------------------------------------
runQuery(`drop schema ${SCHEMA} cascade;`);
console.log(`\nDropped schema ${SCHEMA}.`);
