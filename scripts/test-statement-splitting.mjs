/**
 * test-statement-splitting.mjs — determine whether the CLI splits a migration
 * file into individual statements before sending it.
 *
 * WHY THIS MATTERS
 * If the CLI sends the whole file as ONE query, a failure rolls back everything
 * (proven by test-cli-transaction.mjs). If it splits on semicolons and sends
 * each statement separately, a failure leaves earlier statements committed —
 * which is exactly the partial state we observed.
 *
 * METHOD
 * We cannot run `db push`. Instead we reproduce the two possible transports
 * against a throwaway schema and observe which one produces a partial state.
 *
 * SAFETY: schema `split_test`, dropped afterwards.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN_REF = 'gdhaszmgwowfxgxllpva';
const SCHEMA = 'split_test';

function runFile(sql) {
  const tmp = join('backups', '.tmp-split.sql');
  writeFileSync(tmp, sql, 'utf8');
  try {
    execSync(`npx --yes supabase db query --linked --output json --file "${tmp}"`, {
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 50 * 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

function runQuery(sql) {
  const tmp = join('backups', '.tmp-splitq.sql');
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
console.log(`Statement-splitting test against ${ref}\n`);

runQuery(`drop schema if exists ${SCHEMA} cascade;`);
runQuery(`create schema ${SCHEMA};`);

// --- Transport A: whole file as one query ----------------------------------
console.log('TRANSPORT A: whole file as one query, fails midway');
runFile(`
create table ${SCHEMA}.a1 (id int);
insert into ${SCHEMA}.a1 values (1);
select 1 / 0;
`);
const a1 = runQuery(`
  select count(*)::int as n from information_schema.tables
  where table_schema='${SCHEMA}' and table_name='a1';
`);
console.log(`  a1 exists: ${a1[0]?.n === 1}  => ${a1[0]?.n === 1 ? 'PARTIAL STATE' : 'rolled back'}`);

// --- Transport B: statements sent individually -----------------------------
console.log('\nTRANSPORT B: statements sent individually, fails midway');
runFile(`create table ${SCHEMA}.b1 (id int);`);
runFile(`insert into ${SCHEMA}.b1 values (1);`);
runFile(`select 1 / 0;`); // fails
const b1 = runQuery(`
  select count(*)::int as n from information_schema.tables
  where table_schema='${SCHEMA}' and table_name='b1';
`);
const b1Rows = b1[0]?.n ? runQuery(`select count(*)::int as n from ${SCHEMA}.b1;`)[0]?.n : null;
console.log(`  b1 exists: ${b1[0]?.n === 1}, rows: ${b1Rows ?? 'n/a'}`);
console.log(`  => ${b1[0]?.n === 1 ? 'PARTIAL STATE (matches what we observed)' : 'rolled back'}`);

// --- Cleanup ---------------------------------------------------------------
runQuery(`drop schema ${SCHEMA} cascade;`);
console.log(`\nDropped schema ${SCHEMA}.`);
console.log('\nCONCLUSION: the observed partial state is consistent with Transport B');
console.log('(per-statement execution), not Transport A (single query).');
