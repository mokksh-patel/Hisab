// Temporary verification script for the pgTAP test files.
// Counts dollar-quote delimiters, assertions and plan() declarations.
import { readFileSync } from 'node:fs';

const DOLLAR = String.fromCharCode(36);

for (const file of [
  'supabase/tests/01_security_test.sql',
  'supabase/tests/02_view_isolation_test.sql',
]) {
  const content = readFileSync(file, 'utf8');

  let i = 0;
  let doubleTokens = 0;
  let loneDollars = 0;
  while (i < content.length) {
    if (content[i] === DOLLAR) {
      if (content[i + 1] === DOLLAR) {
        doubleTokens += 1;
        i += 2;
        continue;
      }
      loneDollars += 1;
    }
    i += 1;
  }

  const assertions =
    content.match(/^\s*select\s+(is|isnt|ok|throws_ok|lives_ok|cmp_ok|pass|fail)\s*\(/gm) ?? [];
  const planMatch = content.match(/select plan\((\d+)\)/);
  const plan = planMatch ? Number(planMatch[1]) : null;

  console.log(`=== ${file}`);
  console.log(`  assertions: ${assertions.length} | plan: ${plan} | ${assertions.length === plan ? 'MATCH' : 'MISMATCH'}`);
  console.log(`  double-dollar tokens: ${doubleTokens} | balanced: ${doubleTokens % 2 === 0}`);
  console.log(`  lone dollar chars: ${loneDollars}`);
  console.log(`  begin: ${/^\s*begin;/m.test(content)} | rollback: ${/^\s*rollback;/m.test(content)}`);
  console.log(`  finish(): ${/select \* from finish\(\)/.test(content)}`);
  console.log(`  generated-col filter: ${/is_generated = 'NEVER'/.test(content)}`);
  console.log(`  identity filter: ${/is_identity = 'NO'/.test(content)}`);
  console.log(`  default filter: ${/column_default is null/.test(content)}`);
}
