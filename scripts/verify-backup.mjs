/**
 * verify-backup.mjs — integrity check for a backup directory.
 *
 * Recomputes the SHA-256 of every exported table file and compares it with the
 * manifest. This proves the backup is internally consistent and unmodified.
 *
 * It does NOT prove the data can be restored into a live database — that
 * requires a restore rehearsal (see BACKUP_AND_RECOVERY.md).
 *
 * Usage: node scripts/verify-backup.mjs backups/<timestamp>
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/verify-backup.mjs backups/<timestamp>');
  process.exit(1);
}

const manifestPath = join(dir, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`No manifest found at ${manifestPath}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
let failures = 0;
let checked = 0;

console.log(`Verifying backup from ${manifest.createdAt}\n`);

for (const [table, meta] of Object.entries(manifest.tables)) {
  if (meta.error) {
    console.error(`  ${table.padEnd(22)} SKIPPED (export failed)`);
    failures += 1;
    continue;
  }

  const file = join(dir, `${table}.json`);
  if (!existsSync(file)) {
    console.error(`  ${table.padEnd(22)} MISSING FILE`);
    failures += 1;
    continue;
  }

  const content = readFileSync(file, 'utf8');
  const actual = createHash('sha256').update(content).digest('hex');
  const rows = JSON.parse(content).length;

  const checksumOk = actual === meta.sha256;
  const rowsOk = rows === meta.rows;

  if (checksumOk && rowsOk) {
    console.log(`  ${table.padEnd(22)} OK  ${String(rows).padStart(6)} rows`);
  } else {
    console.error(
      `  ${table.padEnd(22)} FAIL  checksum ${checksumOk ? 'ok' : 'MISMATCH'}, rows ${rows}/${meta.rows}`,
    );
    failures += 1;
  }
  checked += 1;
}

console.log(`\n${checked} table(s) verified, ${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
