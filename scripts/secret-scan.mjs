/**
 * secret-scan.mjs — scans the working tree for credential patterns.
 *
 * Run BEFORE `git add`. Exits non-zero if anything suspicious is found.
 *
 * Usage: node scripts/secret-scan.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

// Directories that never contain source we would commit.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  'test-results',
  'playwright-report',
  'blob-report',
  '.playwright',
  '.cache',
  'tmp',
  'temp',
]);

// Files that are expected to contain placeholder or test values.
const ALLOWLIST = new Set([
  '.env.example',
  'scripts/secret-scan.mjs',
  'SECURITY_CHECKLIST.md',
  'PILOT_READINESS.md',
  'TECHNICAL_DECISIONS.md',
  'BUILD_PROGRESS.md',
  'DEPLOYMENT.md',
  'BACKUP_AND_RECOVERY.md',
  // Contains deliberately fake credentials used to prove the monitoring
  // sanitiser redacts them. They are not real and never leave the test process.
  'tests/unit/monitoring.test.ts',
]);

const PATTERNS = [
  { name: 'Supabase secret key', re: /sb_secret_[A-Za-z0-9_-]{10,}/ },
  { name: 'Supabase service_role JWT', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'Generic API key assignment', re: /(api[_-]?key|apikey)\s*[:=]\s*['"][A-Za-z0-9_-]{20,}['"]/i },
  { name: 'Password assignment', re: /(password|passwd|pwd)\s*[:=]\s*['"][^'"\s]{8,}['"]/i },
  { name: 'Private key block', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'SMTP credential', re: /smtp[_-]?(password|pass|secret)\s*[:=]\s*['"][^'"]+['"]/i },
  { name: 'Postgres URL with password', re: /postgres(ql)?:\/\/[^:\s]+:[^@\s]+@/ },
];

// Values that are obviously placeholders, not real credentials.
const PLACEHOLDER = /(your[-_]|example|placeholder|xxx+|changeme|<[^>]+>|test|dummy|fake|redacted|\*\*\*)/i;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      walk(full, out);
    } else if (stats.size < 2_000_000) {
      out.push(full);
    }
  }
  return out;
}

const findings = [];
const files = walk(ROOT);

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (ALLOWLIST.has(rel)) continue;
  // Skip binary-ish files.
  if (/\.(png|jpg|jpeg|gif|ico|woff2?|ttf|zip|dump|gz)$/i.test(rel)) continue;

  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const pattern of PATTERNS) {
      if (!pattern.re.test(line)) continue;
      if (PLACEHOLDER.test(line)) continue;
      findings.push({ file: rel, line: index + 1, pattern: pattern.name, text: line.trim().slice(0, 120) });
    }
  });
}

console.log(`Scanned ${files.length} files.\n`);

if (findings.length === 0) {
  console.log('No credential patterns found.');
  process.exit(0);
}

console.log(`FOUND ${findings.length} potential secret(s):\n`);
for (const finding of findings) {
  console.log(`  ${finding.file}:${finding.line}  [${finding.pattern}]`);
  console.log(`    ${finding.text}\n`);
}
process.exit(1);
