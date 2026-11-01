// Repairs single-dollar delimiters that should be double-dollar.
// A lone `$` at the start of a line (optionally indented) or immediately before
// a trailing comma/semicolon is a broken `$$` delimiter.
import { readFileSync, writeFileSync } from 'node:fs';

const DOLLAR = String.fromCharCode(36);
const DOUBLE = DOLLAR + DOLLAR;

const files = [
  'supabase/tests/01_security_test.sql',
  'supabase/tests/02_view_isolation_test.sql',
  'supabase/tests/03_invoice_engine_v2_test.sql',
];

for (const file of files) {
  const original = readFileSync(file, 'utf8');
  const lines = original.split(/\r?\n/);
  let fixed = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let out = '';
    let j = 0;
    while (j < line.length) {
      if (line[j] === DOLLAR) {
        if (line[j + 1] === DOLLAR) {
          out += DOUBLE;
          j += 2;
          continue;
        }
        // Lone dollar: promote to a double-dollar delimiter.
        out += DOUBLE;
        fixed += 1;
        j += 1;
        continue;
      }
      out += line[j];
      j += 1;
    }
    lines[i] = out;
  }

  writeFileSync(file, lines.join('\n'), 'utf8');
  console.log(`${file}: promoted ${fixed} lone dollar(s)`);
}
