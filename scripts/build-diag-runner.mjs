// Runs a pgTAP file and returns the diagnostic SELECT output that appears
// immediately before the first record_payment() call.
//
// `supabase db query` returns only the final result set, so we capture the
// diagnostic rows into a temp table and read them back at the end.
import { readFileSync, writeFileSync } from 'node:fs';

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error('usage: node scripts/build-diag-runner.mjs <input.sql> <output.sql>');
  process.exit(1);
}

let sql = readFileSync(input, 'utf8');

// Capture the two diagnostic SELECTs into a temp table.
sql = sql.replace(
  /select\s+current_user\s+as current_user,[\s\S]*?current_setting\('request\.jwt\.claim\.sub', true\)\s+as jwt_claim_sub;/,
  `create temp table diag_identity as
select
  current_user as current_user,
  session_user as session_user,
  auth.uid() as auth_uid,
  current_setting('request.jwt.claims', true) as jwt_claims,
  current_setting('request.jwt.claim.sub', true) as jwt_claim_sub;`,
);

sql = sql.replace(
  /select\s+\(select count\(\*\) from public\.customers[\s\S]*?as can_write_financials;/,
  `create temp table diag_fixtures as
select
  (select count(*) from public.customers
    where id = 'c0000000-0000-0000-0000-00000000000a') as customer_by_id,
  (select count(*) from public.customers
    where id = 'c0000000-0000-0000-0000-00000000000a'
      and business_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') as customer_by_id_and_business,
  (select business_id from public.customers
    where id = 'c0000000-0000-0000-0000-00000000000a') as customer_business_id,
  (select count(*) from public.business_members
    where business_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      and user_id = auth.uid()
      and invitation_status = 'accepted') as membership_rows,
  public.can_write_financials('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') as can_write_financials;`,
);

// Replace finish() and rollback with reads of the captured diagnostics.
sql = sql.replace(
  /select \* from finish\(\);/,
  "create temp table tap_result as select string_agg(t, E'\\n') as summary from finish() t;",
);
sql = sql.replace(/rollback;\s*$/, '');

sql += `
select 'IDENTITY' as section, current_user::text as a, auth_uid::text as b,
       jwt_claims as c, jwt_claim_sub as d
from diag_identity
union all
select 'FIXTURES', customer_by_id::text, customer_by_id_and_business::text,
       customer_business_id::text, membership_rows::text
from diag_fixtures
union all
select 'CAN_WRITE', can_write_financials::text, null, null, null
from diag_fixtures
union all
select 'TAP', case when summary is null then 'ALL PASSED' else summary end, null, null, null
from tap_result;
`;

writeFileSync(output, sql, 'utf8');
console.log(`built ${output}`);
