-- ===========================================================================
-- BizPilot — pgTAP view isolation tests
--
-- The three reporting views (invoice_balances, payment_balances,
-- customer_receivables) are declared `security_invoker = true`, which means
-- they run with the CALLER's permissions and the RLS policies of the
-- underlying tables still apply.
--
-- That setting is the single most important line in migration 0002: without
-- it a view runs as its owner and would expose every tenant's receivables.
-- These tests prove the setting actually holds at runtime rather than merely
-- being present in the source.
--
-- Run with:  supabase test db
-- ===========================================================================

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(16);

-- ---------------------------------------------------------------------------
-- Fixtures: two businesses, one owner each, one customer each, one issued
-- invoice each with a partial payment. Built as the superuser so RLS does not
-- interfere with setup.
--
-- The auth.users fixture lists only columns that have NO default, and never
-- lists generated or identity columns. `confirmed_at` is a GENERATED ALWAYS
-- column in current GoTrue and must not be supplied explicitly.
-- ---------------------------------------------------------------------------
do $$
declare
  v_columns text;
  v_values text;
  v_unhandled text;
begin
  -- Fail loudly if GoTrue adds a required column we do not know how to fill.
  select string_agg(column_name, ', ' order by ordinal_position)
    into v_unhandled
  from information_schema.columns
  where table_schema = 'auth'
    and table_name = 'users'
    and is_nullable = 'NO'
    and is_generated = 'NEVER'
    and is_identity = 'NO'
    and column_default is null
    and column_name not in (
      'id', 'instance_id', 'aud', 'role', 'email', 'encrypted_password',
      'email_confirmed_at', 'created_at', 'updated_at', 'is_sso_user', 'is_anonymous'
    );

  if v_unhandled is not null then
    raise exception
      'auth.users has required column(s) this fixture does not handle: %. Add them to the CASE expression in the fixture.',
      v_unhandled;
  end if;

  select string_agg(quote_ident(column_name), ', ' order by ordinal_position),
         string_agg(
           case column_name
             when 'id' then 'u.id'
             when 'instance_id' then '''00000000-0000-0000-0000-000000000000''::uuid'
             when 'aud' then '''authenticated'''
             when 'role' then '''authenticated'''
             when 'email' then 'u.email'
             when 'encrypted_password' then '''x'''
             when 'email_confirmed_at' then 'now()'
             when 'created_at' then 'now()'
             when 'updated_at' then 'now()'
             when 'is_sso_user' then 'false'
             when 'is_anonymous' then 'false'
             else 'null'
           end,
           ', ' order by ordinal_position
         )
    into v_columns, v_values
  from information_schema.columns
  where table_schema = 'auth'
    and table_name = 'users'
    and is_generated = 'NEVER'
    and is_identity = 'NO'
    and column_default is null;

  execute format(
    'insert into auth.users (%s) select %s from (values
       (''a1111111-1111-1111-1111-111111111111''::uuid, ''view-owner-a@example.test''),
       (''b2222222-2222-2222-2222-222222222222''::uuid, ''view-owner-b@example.test'')
     ) as u(id, email)',
    v_columns, v_values
  );
end;
$$;

insert into public.businesses (id, legal_name, display_name, state_code, invoice_prefix)
values
  ('a0000000-0000-0000-0000-00000000000a', 'View Alpha Pvt Ltd', 'View Alpha', '24', 'VA'),
  ('b0000000-0000-0000-0000-00000000000b', 'View Beta LLP', 'View Beta', '27', 'VB');

insert into public.business_members (business_id, user_id, role, invitation_status)
values
  ('a0000000-0000-0000-0000-00000000000a', 'a1111111-1111-1111-1111-111111111111', 'owner', 'accepted'),
  ('b0000000-0000-0000-0000-00000000000b', 'b2222222-2222-2222-2222-222222222222', 'owner', 'accepted');

insert into public.customers (id, business_id, customer_name, phone, state_code)
values
  ('ca000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-00000000000a', 'Alpha View Customer', '+919000000101', '24'),
  ('cb000000-0000-0000-0000-00000000000b', 'b0000000-0000-0000-0000-00000000000b', 'Beta View Customer', '+919000000102', '27');

-- Two issued invoices per business so the aggregates are non-trivial.
insert into public.invoices (
  id, business_id, customer_id, invoice_number, financial_year, invoice_date,
  due_date, document_state, gst_mode, subtotal_paise, taxable_amount_paise,
  total_amount_paise, issued_at
)
values
  ('1a000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-00000000000a',
   'ca000000-0000-0000-0000-00000000000a', 'VA-001', '2026-27', '2026-10-01',
   '2026-10-31', 'issued', 'intra_state', 100000, 100000, 100000, now()),
  ('2a000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-00000000000a',
   'ca000000-0000-0000-0000-00000000000a', 'VA-002', '2026-27', '2026-10-02',
   '2026-11-01', 'issued', 'intra_state', 200000, 200000, 200000, now()),
  ('1b000000-0000-0000-0000-00000000000b', 'b0000000-0000-0000-0000-00000000000b',
   'cb000000-0000-0000-0000-00000000000b', 'VB-001', '2026-27', '2026-10-03',
   '2026-10-31', 'issued', 'intra_state', 500000, 500000, 500000, now());

-- A payment in business A allocated to VA-001, so outstanding is not the total.
insert into public.payments (
  id, business_id, customer_id, payment_date, amount_paise, payment_method,
  idempotency_key, created_by
)
values
  ('9a000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-00000000000a',
   'ca000000-0000-0000-0000-00000000000a', '2026-10-05', 40000, 'upi',
   'view-test-key-0001', 'a1111111-1111-1111-1111-111111111111');

insert into public.payment_allocations (
  business_id, payment_id, invoice_id, allocated_amount_paise, created_by
)
values
  ('a0000000-0000-0000-0000-00000000000a', '9a000000-0000-0000-0000-00000000000a',
   '1a000000-0000-0000-0000-00000000000a', 40000, 'a1111111-1111-1111-1111-111111111111');

-- ===========================================================================
-- 1. invoice_balances — tenant isolation
-- ===========================================================================
set local role authenticated;
set local request.jwt.claims = '{"sub":"b2222222-2222-2222-2222-222222222222","role":"authenticated"}';

select is(
  (select count(*)::int from public.invoice_balances
   where business_id = 'a0000000-0000-0000-0000-00000000000a'),
  0,
  'invoice_balances: Business B cannot see Business A rows'
);

select is(
  (select count(*)::int from public.invoice_balances),
  1,
  'invoice_balances: Business B sees only its own single invoice'
);

select is(
  (select coalesce(sum(outstanding_paise), 0)::numeric from public.invoice_balances
   where business_id = 'a0000000-0000-0000-0000-00000000000a'),
  0::numeric,
  'invoice_balances: Business B cannot aggregate Business A outstanding'
);

-- Business A owner sees its own two invoices with correct derived balances.
set local request.jwt.claims = '{"sub":"a1111111-1111-1111-1111-111111111111","role":"authenticated"}';

select is(
  (select count(*)::int from public.invoice_balances
   where business_id = 'a0000000-0000-0000-0000-00000000000a'),
  2,
  'invoice_balances: Business A sees both of its own invoices'
);

select is(
  (select outstanding_paise from public.invoice_balances where invoice_number = 'VA-001'),
  60000::numeric,
  'invoice_balances: outstanding is total minus allocated (100000 - 40000)'
);

select is(
  (select outstanding_paise from public.invoice_balances where invoice_number = 'VA-002'),
  200000::numeric,
  'invoice_balances: an unpaid invoice reports its full total as outstanding'
);

-- ===========================================================================
-- 2. customer_receivables — tenant isolation
-- ===========================================================================
set local request.jwt.claims = '{"sub":"b2222222-2222-2222-2222-222222222222","role":"authenticated"}';

select is(
  (select count(*)::int from public.customer_receivables
   where business_id = 'a0000000-0000-0000-0000-00000000000a'),
  0,
  'customer_receivables: Business B cannot see Business A customers'
);

select is(
  (select count(*)::int from public.customer_receivables),
  1,
  'customer_receivables: Business B sees only its own customer'
);

select is(
  (select coalesce(sum(outstanding_paise), 0)::numeric from public.customer_receivables
   where business_id = 'a0000000-0000-0000-0000-00000000000a'),
  0::numeric,
  'customer_receivables: Business B cannot aggregate Business A receivables'
);

set local request.jwt.claims = '{"sub":"a1111111-1111-1111-1111-111111111111","role":"authenticated"}';

select is(
  (select outstanding_paise from public.customer_receivables
   where customer_id = 'ca000000-0000-0000-0000-00000000000a'),
  260000::numeric,
  'customer_receivables: outstanding sums both invoices (60000 + 200000)'
);

select is(
  (select total_invoiced_paise from public.customer_receivables
   where customer_id = 'ca000000-0000-0000-0000-00000000000a'),
  300000::numeric,
  'customer_receivables: total invoiced is the sum of issued invoice totals'
);

select is(
  (select open_invoice_count::bigint from public.customer_receivables
   where customer_id = 'ca000000-0000-0000-0000-00000000000a'),
  2::bigint,
  'customer_receivables: both invoices count as open'
);

-- ===========================================================================
-- 3. payment_balances — tenant isolation
-- ===========================================================================
set local request.jwt.claims = '{"sub":"b2222222-2222-2222-2222-222222222222","role":"authenticated"}';

select is(
  (select count(*)::int from public.payment_balances
   where business_id = 'a0000000-0000-0000-0000-00000000000a'),
  0,
  'payment_balances: Business B cannot see Business A payments'
);

set local request.jwt.claims = '{"sub":"a1111111-1111-1111-1111-111111111111","role":"authenticated"}';

select is(
  (select allocated_paise from public.payment_balances
   where payment_id = '9a000000-0000-0000-0000-00000000000a'),
  40000::numeric,
  'payment_balances: Business A sees its own payment allocation'
);

-- ===========================================================================
-- 4. Unauthenticated access to the views is denied
--
--   invoice_balances and customer_receivables are declared with
--   security_invoker = true, so they read the underlying tables with the
--   CALLER's privileges. anon holds no SELECT on public.invoices (revoked in
--   migration 0005) and no SELECT on the views themselves (granted only to
--   authenticated in migration 0002), so the query is rejected with 42501
--   instead of returning zero rows.
--
--   security_invoker is deliberately left true: flipping it to false would
--   make the views run as their owner and bypass tenant RLS entirely.
-- ===========================================================================
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

select throws_ok(
  $$ select count(*) from public.invoice_balances $$,
  '42501',
  null,
  'invoice_balances: anon is denied by privilege'
);

select throws_ok(
  $$ select count(*) from public.customer_receivables $$,
  '42501',
  null,
  'customer_receivables: anon is denied by privilege'
);

reset role;

select * from finish();
rollback;
