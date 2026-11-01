// Splits a pgTAP test file into its individual assertions and reports which
// ones fail, by running the whole file but capturing each assertion's TAP line.
//
// Strategy: pgTAP's assertion functions return SETOF text. We rewrite each
// `select is(...)` / `select throws_ok(...)` etc. into
//   `insert into tap_lines select ... from is(...)`
// so every TAP line is stored as a row we can read back.
import { readFileSync, writeFileSync } from 'node:fs';

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error('usage: node scripts/build-tap-lines.mjs <input.sql> <output.sql>');
  process.exit(1);
}

const source = readFileSync(input, 'utf8');
const lines = source.split(/\r?\n/);

const out = [];
let i = 0;
let assertionIndex = 0;

// Prepend the capture table.
out.push('create temp table tap_lines (seq serial primary key, line text);');
out.push('grant all on tap_lines to authenticated, anon;');
out.push('grant all on sequence tap_lines_seq_seq to authenticated, anon;');
out.push('');

while (i < lines.length) {
  const line = lines[i];

  // Detect the start of an assertion call.
  const match = /^(\s*)select\s+(is|isnt|ok|throws_ok|lives_ok|cmp_ok)\s*\(/.exec(line);
  if (!match) {
    out.push(line);
    i += 1;
    continue;
  }

  // Collect the full statement up to the terminating `);`.
  const statement = [];
  let depth = 0;
  let started = false;
  while (i < lines.length) {
    const current = lines[i];
    statement.push(current);
    for (const ch of current) {
      if (ch === '(') {
        depth += 1;
        started = true;
      } else if (ch === ')') {
        depth -= 1;
      }
    }
    i += 1;
    if (started && depth === 0 && current.trimEnd().endsWith(';')) break;
  }

  assertionIndex += 1;
  const fn = match[2];
  const joined = statement.join('\n');

  // Rewrite `select fn(` -> `insert into tap_lines (line) select * from fn(`
  const rewritten = joined.replace(
    new RegExp(`^(\\s*)select\\s+${fn}\\s*\\(`),
    `$1insert into tap_lines (line) select * from ${fn}(`,
  );

  out.push(`-- assertion ${assertionIndex}`);
  out.push(rewritten);
}

// Replace finish() and rollback with a final read of the captured lines.
let finalSql = out.join('\n');
finalSql = finalSql.replace(
  /select \* from finish\(\);/,
  "create temp table tap_result as select string_agg(t, E'\\n') as summary from finish() t;",
);
finalSql = finalSql.replace(/rollback;\s*$/, '');

finalSql += `
select seq, line from tap_lines where line not like 'ok %' order by seq;
`;

writeFileSync(output, finalSql, 'utf8');
console.log(`built ${output} with ${assertionIndex} assertions`);
