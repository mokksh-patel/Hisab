/**
 * Static SQL sanity checker for BizPilot migrations.
 *
 * This is NOT a SQL parser. It catches the mistakes that are cheap to make and
 * expensive to discover against a hosted database:
 *   - unbalanced dollar-quoted function bodies ($$ ... $$)
 *   - unbalanced parentheses outside of string literals
 *   - unterminated single-quoted strings
 *   - statements that do not end with a semicolon
 *   - CREATE TABLE / CREATE POLICY / CREATE FUNCTION without a matching name
 *   - duplicate object names within a migration
 *
 * Run with: node scripts/check-sql.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = 'supabase/migrations';

/** Remove comments and string literals so structural checks are not fooled. */
function stripNoise(sql) {
  let out = '';
  let i = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let inString = false;
  let inDollar = false;

  while (i < sql.length) {
    const two = sql.slice(i, i + 2);

    if (inLineComment) {
      if (sql[i] === '\n') {
        inLineComment = false;
        out += '\n';
      }
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (two === '*/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (inDollar) {
      if (two === '$$') {
        inDollar = false;
        out += '$$';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (inString) {
      if (sql[i] === "'") {
        if (sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        inString = false;
        out += "'";
      }
      i += 1;
      continue;
    }

    if (two === '--') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (two === '/*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (two === '$$') {
      inDollar = true;
      out += '$$';
      i += 2;
      continue;
    }
    if (sql[i] === "'") {
      inString = true;
      out += "'";
      i += 1;
      continue;
    }

    out += sql[i];
    i += 1;
  }

  return { cleaned: out, unterminatedString: inString, unterminatedDollar: inDollar, unterminatedBlock: inBlockComment };
}

function checkFile(file) {
  const path = join(MIGRATIONS_DIR, file);
  const raw = readFileSync(path, 'utf8');
  const problems = [];

  const { cleaned, unterminatedString, unterminatedDollar, unterminatedBlock } = stripNoise(raw);
  if (unterminatedString) problems.push('unterminated single-quoted string');
  if (unterminatedDollar) problems.push('unbalanced $$ dollar quote');
  if (unterminatedBlock) problems.push('unterminated /* block comment');

  // Parenthesis balance outside strings/comments.
  let depth = 0;
  for (const char of cleaned) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth < 0) {
      problems.push('unbalanced closing parenthesis');
      break;
    }
  }
  if (depth > 0) problems.push(`unbalanced parentheses (${depth} unclosed)`);

  // Every statement should end with a semicolon.
  const statements = cleaned
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  const lastStatement = cleaned.trim();
  if (lastStatement && !lastStatement.endsWith(';')) {
    problems.push('file does not end with a semicolon');
  }

  // Named objects must have a name.
  const namedPatterns = [
    [/create\s+(?:or\s+replace\s+)?function\s+([a-z_][\w.]*)\s*\(/gi, 'function'],
    [/create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][\w.]*)/gi, 'table'],
    [/create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?([a-z_][\w.]*)/gi, 'index'],
    [/create\s+policy\s+([a-z_][\w]*)/gi, 'policy'],
    [/create\s+trigger\s+([a-z_][\w]*)/gi, 'trigger'],
    [/create\s+type\s+([a-z_][\w.]*)/gi, 'type'],
    [/create\s+(?:or\s+replace\s+)?view\s+([a-z_][\w.]*)/gi, 'view'],
  ];

  const seen = new Map();
  for (const [pattern, kind] of namedPatterns) {
    for (const match of cleaned.matchAll(pattern)) {
      const name = match[1];
      if (!name) {
        problems.push(`${kind} without a name`);
        continue;
      }

      // Functions may be legitimately OVERLOADED: the same name with a
      // different argument list is a distinct function in PostgreSQL. Key on
      // the normalised argument types so an overload is not a false positive.
      let key = `${kind}:${name.toLowerCase()}`;
      if (kind === 'function') {
        const argsStart = match.index + match[0].length;
        const argsEnd = cleaned.indexOf(')', argsStart);
        const args = argsEnd === -1 ? '' : cleaned.slice(argsStart, argsEnd);
        const argTypes = args
          .split(',')
          .map((arg) => arg.trim().split(/\s+/).slice(1).join(' ').toLowerCase())
          .filter(Boolean)
          .join(',');
        key = `${key}(${argTypes})`;
      }

      if (seen.has(key)) {
        problems.push(`duplicate ${kind} "${name}" (first at offset ${seen.get(key)})`);
      } else {
        seen.set(key, match.index);
      }
    }
  }

  // RLS must be enabled for every table created in the schema migration.
  if (file.includes('core_schema')) {
    const tables = [...cleaned.matchAll(/create\s+table\s+public\.([a-z_]+)/gi)].map((m) => m[1]);
    const rlsFile = readdirSync(MIGRATIONS_DIR).find((f) => f.includes('rls_policies'));
    const rlsSql = rlsFile ? readFileSync(join(MIGRATIONS_DIR, rlsFile), 'utf8') : '';
    if (tables.length === 0) {
      problems.push('no tables found in the schema migration — the RLS check would be vacuous');
    }
    for (const table of tables) {
      if (!new RegExp(`alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`, 'i').test(rlsSql)) {
        problems.push(`table public.${table} has no "enable row level security" statement`);
      }
    }
    console.log(`      RLS verified for ${tables.length} tables: ${tables.join(', ')}`);
  }

  return { file, statements: statements.length, problems };
}

const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
let failed = false;

for (const file of files) {
  const { statements, problems } = checkFile(file);
  if (problems.length === 0) {
    console.log(`OK    ${file} (${statements} statements)`);
  } else {
    failed = true;
    console.log(`FAIL  ${file}`);
    for (const problem of problems) console.log(`        - ${problem}`);
  }
}

if (failed) {
  console.error('\nSQL sanity check failed.');
  process.exit(1);
}
console.log('\nAll migrations passed the static sanity check.');
