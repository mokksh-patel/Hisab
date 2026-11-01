// Builds a runnable variant of a pgTAP test file that reports a pass/fail
// summary through `supabase db query`, which only returns the final result set.
//
// pgTAP's finish() returns SETOF text and emits rows ONLY when something failed.
// So: zero rows => every assertion passed.
import { readFileSync, writeFileSync } from 'node:fs';

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error('usage: node scripts/build-tap-runner.mjs <input.sql> <output.sql>');
  process.exit(1);
}

let sql = readFileSync(input, 'utf8');

// Replace the TAP-emitting finish() with a captured summary.
sql = sql.replace(
  /select \* from finish\(\);/,
  "create temp table tap_result as select string_agg(t, E'\\n') as summary from finish() t;",
);

// Drop the trailing rollback so the temp table survives to the final select.
sql = sql.replace(/rollback;\s*$/, '');

sql += `
select
  case
    when summary is null then 'ALL PASSED'
    else summary
  end as result
from tap_result;
`;

writeFileSync(output, sql, 'utf8');
console.log(`built ${output} from ${input}`);
