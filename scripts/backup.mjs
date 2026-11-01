/**
 * backup.mjs — logical backup of the BizPilot database.
 *
 * WHY THIS EXISTS
 * `supabase db dump` requires Docker, which is unavailable in this environment.
 * The Supabase Management API (`supabase db query --linked`) works without
 * Docker, so this script exports every table as JSON through it.
 *
 * WHAT IT PRODUCES
 *   backups/<timestamp>/manifest.json   — metadata, row counts, checksums
 *   backups/<timestamp>/<table>.json    — one file per table
 *
 * WHAT IT DOES NOT COVER
 *   - Storage API file contents (no buckets are used by BizPilot today)
 *   - auth.users passwords (bcrypt hashes are exported; they are not reversible)
 *   - Database roles, extensions and RLS policies (those live in migrations)
 *
 * For a full physical backup including roles and policies, use
 * `supabase db dump` on a machine with Docker, or enable Supabase's managed
 * backups on a paid plan.
 *
 * Usage:
 *   node scripts/backup.mjs                 # backup the linked project
 *   node scripts/backup.mjs --project-ref X # backup a specific project
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TABLES = [
  'businesses',
  'profiles',
  'business_members',
  'customers',
  'invoice_sequences',
  'invoices',
  'invoice_items',
  'payments',
  'payment_allocations',
  'reminder_logs',
  'audit_logs',
];

const args = process.argv.slice(2);
const refIndex = args.indexOf('--project-ref');
const projectRef = refIndex !== -1 ? args[refIndex + 1] : null;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join('backups', stamp);
mkdirSync(outDir, { recursive: true });

function runQuery(sql) {
  const refFlag = projectRef ? `--project-ref ${projectRef}` : '--linked';
  const escaped = sql.replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
  const output = execSync(
    `npx --yes supabase db query ${refFlag} --output json "${escaped}"`,
    { encoding: 'utf8', timeout: 300_000, maxBuffer: 200 * 1024 * 1024 },
  );
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  return JSON.parse(output.slice(start, end + 1));
}

console.log(`Backing up ${projectRef ?? 'linked project'} to ${outDir}\n`);

const manifest = {
  createdAt: new Date().toISOString(),
  projectRef: projectRef ?? 'linked',
  tables: {},
  totalRows: 0,
};

for (const table of TABLES) {
  try {
    const rows = runQuery(`select coalesce(json_agg(t), '[]'::json) as data from public.${table} t;`);
    const data = rows[0]?.data ?? [];
    const json = JSON.stringify(data, null, 2);
    const checksum = createHash('sha256').update(json).digest('hex');

    writeFileSync(join(outDir, `${table}.json`), json, 'utf8');

    manifest.tables[table] = { rows: data.length, sha256: checksum };
    manifest.totalRows += data.length;

    console.log(`  ${table.padEnd(22)} ${String(data.length).padStart(6)} rows  ${checksum.slice(0, 12)}`);
  } catch (error) {
    manifest.tables[table] = { error: String(error.message ?? error) };
    console.error(`  ${table.padEnd(22)} FAILED: ${error.message ?? error}`);
  }
}

writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

console.log(`\nTotal rows: ${manifest.totalRows}`);
console.log(`Manifest:   ${join(outDir, 'manifest.json')}`);

const failures = Object.values(manifest.tables).filter((t) => t.error).length;
if (failures > 0) {
  console.error(`\n${failures} table(s) failed to export.`);
  process.exit(1);
}
console.log('\nBackup complete.');
