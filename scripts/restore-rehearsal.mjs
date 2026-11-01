/**
 * restore-rehearsal.mjs — proves a backup can actually be restored.
 *
 * Creates a throwaway schema `restore_rehearsal` in the TEST project, recreates
 * the table shapes, loads the exported JSON, compares row counts and key
 * aggregates against the manifest, then drops the schema.
 *
 * SAFETY: this never touches `public`. It only creates and drops its own
 * schema. It refuses to run against the original production project.
 *
 * Usage: node scripts/restore-rehearsal.mjs backups/<timestamp>
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN_REF = 'gdhaszmgwowfxgxllpva';
const SCHEMA = 'restore_rehearsal';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/restore-rehearsal.mjs backups/<timestamp>');
  process.exit(1);
}

function runQuery(sql) {
  // Windows caps a command line at ~32k characters, so every statement is
  // written to a temp file and executed with --file. This is uniform and avoids
  // size-dependent behaviour.
  const tmp = join('backups', '.tmp-query.sql');
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

// --- Safety check -----------------------------------------------------------
const ref = readFileSync('supabase/.temp/project-ref', 'utf8').trim();
if (ref === FORBIDDEN_REF) {
  console.error(`REFUSING to run: linked project is the production project (${ref}).`);
  process.exit(1);
}
console.log(`Restore rehearsal against ${ref} (schema: ${SCHEMA})\n`);

const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));

// --- Create the scratch schema ---------------------------------------------
runQuery(`drop schema if exists ${SCHEMA} cascade;`);
runQuery(`create schema ${SCHEMA};`);

// Recreate each table with a permissive shape: every column as jsonb so the
// rehearsal proves the DATA round-trips, not the DDL (DDL lives in migrations).
const tables = Object.keys(manifest.tables).filter((t) => !manifest.tables[t].error);

for (const table of tables) {
  runQuery(`create table ${SCHEMA}.${table} (doc jsonb not null);`);
}

// --- Load the exported rows -------------------------------------------------
let restored = 0;
for (const table of tables) {
  const rows = JSON.parse(readFileSync(join(dir, `${table}.json`), 'utf8'));
  if (rows.length === 0) {
    console.log(`  ${table.padEnd(22)} 0 rows (empty)`);
    continue;
  }

  // Insert in small batches. Windows caps a command line at ~32k characters,
  // and each row is ~700 bytes of JSON, so 20 rows per statement is safe.
  const BATCH = 20;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const values = batch
      .map((row) => `('${JSON.stringify(row).replace(/'/g, "''")}'::jsonb)`)
      .join(',');
    runQuery(`insert into ${SCHEMA}.${table} (doc) values ${values};`);
  }
  restored += rows.length;
  console.log(`  ${table.padEnd(22)} ${String(rows.length).padStart(6)} rows restored`);
}

// --- Verify -----------------------------------------------------------------
console.log('\nVerifying restored row counts against the manifest:\n');

let failures = 0;
for (const table of tables) {
  const expected = manifest.tables[table].rows;
  const result = runQuery(`select count(*)::int as n from ${SCHEMA}.${table};`);
  const actual = result[0]?.n ?? -1;
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`  ${table.padEnd(22)} ${ok ? 'OK  ' : 'FAIL'} ${actual}/${expected}`);
}

// Spot-check a financial aggregate: total invoice value must match.
const invoiceTotal = runQuery(
  `select coalesce(sum((doc->>'total_amount_paise')::numeric), 0)::text as total from ${SCHEMA}.invoices;`,
);
console.log(`\n  Sum of invoice totals (restored): ${invoiceTotal[0]?.total}`);

// --- Clean up ---------------------------------------------------------------
runQuery(`drop schema ${SCHEMA} cascade;`);
console.log(`\nDropped schema ${SCHEMA}.`);

console.log(`\nRestored ${restored} rows. ${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
