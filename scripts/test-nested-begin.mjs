/**
 * test-nested-begin.mjs — determine whether an explicit BEGIN inside a
 * CLI-managed transaction causes an error.
 *
 * The CLI resolves a migration file to transactionMode "transactional" unless
 * its first line is exactly `-- pg-delta: transaction=false`. In transactional
 * mode the CLI wraps the file. If the file ALSO contains BEGIN/COMMIT, that is
 * a nested transaction.
 *
 * PostgreSQL does NOT error on a nested BEGIN — it emits a warning and treats
 * it as a no-op. But the inner COMMIT would commit the outer transaction early,
 * which is the real hazard.
 *
 * This test proves what actually happens.
 *
 * SAFETY: schema `nested_test`, dropped afterwards.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN_REF = 'gdhaszmgwowfxgxllpva';
const SCHEMA = 'nested_test';

function runFile(sql) {
  const tmp = join('backups', '.tmp-nested.sql');
  writeFileSync(tmp, sql, 'utf8');
  try {
    const out = execSync(`npx --yes supabase db query --linked --output json --file "${tmp}"`, {
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 50 * 1024 * 1024,
    });
    return { ok: true, out };
  } catch (error) {
    return { ok: false, out: String(error.stdout ?? '') + String(error.stderr ?? '') };
  }
}

function runQuery(sql) {
  const tmp = join('backups', '.tmp-nestedq.sql');
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
console.log(`Nested BEGIN test against ${ref}\n`);

runQuery(`drop schema if exists ${SCHEMA} cascade;`);
runQuery(`create schema ${SCHEMA};`);

// --- Test: explicit BEGIN/COMMIT inside an outer transaction ---------------
// We simulate the CLI wrapper by sending an outer BEGIN ... COMMIT around a
// script that itself contains BEGIN ... COMMIT.
console.log('TEST: explicit BEGIN/COMMIT nested inside an outer transaction');

const script = `
begin;
  create table ${SCHEMA}.outer_t (id int);
  begin;
    create table ${SCHEMA}.inner_t (id int);
    insert into ${SCHEMA}.inner_t values (1);
  commit;
  select 1 / 0;
commit;
`;

const result = runFile(script);
console.log(`  script result: ${result.ok ? 'succeeded' : 'failed (expected)'}`);

const tables = runQuery(`
  select table_name from information_schema.tables
  where table_schema='${SCHEMA}' order by table_name;
`);
console.log(`  tables surviving: ${tables.map((t) => t.table_name).join(', ') || '(none)'}`);

const innerRows = tables.some((t) => t.table_name === 'inner_t')
  ? runQuery(`select count(*)::int as n from ${SCHEMA}.inner_t;`)[0]?.n
  : null;

console.log(`  inner_t rows: ${innerRows ?? 'n/a'}`);
console.log('');
console.log('INTERPRETATION:');
if (tables.length === 0) {
  console.log('  The inner COMMIT did NOT commit early — the whole script rolled back.');
  console.log('  Explicit BEGIN/COMMIT inside a CLI-wrapped transaction is harmless.');
} else {
  console.log('  The inner COMMIT DID commit early — partial state survived.');
  console.log('  Explicit BEGIN/COMMIT inside a CLI-wrapped transaction is DANGEROUS.');
}

// --- Cleanup ---------------------------------------------------------------
runQuery(`drop schema ${SCHEMA} cascade;`);
console.log(`\nDropped schema ${SCHEMA}.`);
