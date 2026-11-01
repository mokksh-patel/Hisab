// Locate every lone dollar character (not part of a $$ pair).
import { readFileSync } from 'node:fs';

const DOLLAR = String.fromCharCode(36);

for (const file of [
  'supabase/tests/01_security_test.sql',
  'supabase/tests/02_view_isolation_test.sql',
]) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    let i = 0;
    while (i < line.length) {
      if (line[i] === DOLLAR) {
        if (line[i + 1] === DOLLAR) {
          i += 2;
          continue;
        }
        console.log(`${file} L${index + 1}: ${JSON.stringify(line)}`);
        break;
      }
      i += 1;
    }
  });
}
