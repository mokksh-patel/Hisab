-- ===========================================================================
-- BizPilot — pgTAP security tests
--
-- These tests run against the REAL PostgreSQL policies. They create two
-- independent businesses with separate users and prove that tenant isolation,
-- role restrictions and financial invariants hold at the database level.
--
-- Run with:  supabase test db
-- (Requires the pgTAP extension, which Supabase enables by default.)
-- ===========================================================================

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(66);

-- ---------------------------------------------------------------------------
-- Fixtures: two businesses, four users
-- ---------------------------------------------------------------------------
-- auth.users has many columns that vary between GoTrue versions, so the fixture
-- rows are built dynamically from the live table definition.
--
-- Two rules make this portable:
--   1. Generated columns (is_generated = 'ALWAYS', e.g. `confirmed_at`) and
--      identity columns are NEVER listed — Postgres computes them itself and
--      rejects an explicit value.
--   2. Columns that have a default are omitted entirely so the database applies
--      its own default. Passing an explicit NULL would override that default and
--      can violate a NOT NULL constraint.
--
-- Only columns without a default are supplied explicitly. Any NOT NULL column
-- without a default that this fixture does not recognise raises a clear error
-- instead of failing with an opaque constraint violation.
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
       (''11111111-1111-1111-1111-111111111111''::uuid, ''owner-a@example.test''),
       (''22222222-2222-2222-2222-222222222222''::uuid, ''owner-b@example.test''),
       (''33333333-3333-3333-3333-333333333333''::uuid, ''readonly-a@example.test''),
       (''44444444-4444-4444-4444-444444444444''::uuid, ''staff-a@example.test''),
       (''55555555-5555-5555-5555-555555555555''::uuid, ''admin-a@example.test'')
     ) as u(id, email)',
    v_columns, v_values
  );
end;
$$;

insert into public.businesses (id, legal_name, display_name, state_code, invoice_prefix)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alpha Traders Pvt Ltd', 'Alpha Traders', '24', 'ALP'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Beta Industries LLP', 'Beta Industries', '27', 'BET');

insert into public.business_members (business_id, user_id, role, invitation_status)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 'accepted'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'owner', 'accepted'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'read_only', 'accepted'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '44444444-4444-4444-4444-444444444444', 'collection_staff', 'accepted');

insert into public.customers (id, business_id, customer_name, phone, state_code)
values
  ('c0000000-0000-0000-0000-00000000000a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alpha Customer', '+919000000001', '24'),
  ('c0000000-0000-0000-0000-00000000000b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Beta Customer', '+919000000002', '27');

-- ===========================================================================
-- 1. Tenant isolation — Business B cannot see Business A
-- ===========================================================================
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

select is(
  (select count(*)::int from public.customers where business_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  0,
  'Business B cannot read Business A customers'
);

select is(
  (select count(*)::int from public.customers),
  1,
  'Business B sees only its own customer'
);

select is(
  (select count(*)::int from public.businesses where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  0,
  'Business B cannot read Business A business record'
);

select is(
  (select count(*)::int from public.business_members where business_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  0,
  'Business B cannot read Business A memberships'
);

-- Business A owner can read its own data.
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select is(
  (select count(*)::int from public.customers where business_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1,
  'Business A can read its own customers'
);

select is(
  (select count(*)::int from public.businesses where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1,
  'Business A can read its own business record'
);

-- ===========================================================================
-- 2. Cross-tenant writes are rejected
-- ===========================================================================
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

select throws_ok(
  $$ insert into public.customers (business_id, customer_name)
     values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Injected customer') $$,
  '42501',
  null,
  'Business B cannot insert a customer into Business A'
);

select is(
  (select count(*)::int from public.customers where customer_name = 'Injected customer'),
  0,
  'The rejected cross-tenant insert wrote nothing'
);

-- ===========================================================================
-- 3. Unauthenticated access is denied
-- ===========================================================================
-- Switch to the real `anon` role, not just a claims blob: the previous version
-- stayed on `authenticated` and only proved that a missing `sub` claim yields
-- no rows, which is a weaker claim than "the anon role is denied".
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

select is(
  (select count(*)::int from public.customers),
  0,
  'An unauthenticated user cannot read customers'
);

select is(
  (select count(*)::int from public.invoices),
  0,
  'An unauthenticated user cannot read invoices'
);

select is(
  (select count(*)::int from public.payments),
  0,
  'An unauthenticated user cannot read payments'
);

select throws_ok(
  $$ select public.create_business_with_owner('Anon Co', 'Anon Co') $$,
  '28000',
  null,
  'An unauthenticated user cannot create a business'
);

reset role;

-- ===========================================================================
-- 4. Role restrictions
-- ===========================================================================
-- `reset role` above returned us to the superuser, which bypasses RLS entirely.
-- Every test from here on simulates an authenticated member, so the role must be
-- restored explicitly. Without this the RLS policies are never exercised and
-- SECURITY DEFINER functions see a different effective context than intended.
set local role authenticated;
set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

select is(
  (select count(*)::int from public.customers where business_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1,
  'A read-only member can read their business customers'
);

select throws_ok(
  $$ insert into public.customers (business_id, customer_name)
     values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Read-only insert') $$,
  '42501',
  null,
  'A read-only member cannot insert a customer'
);

-- RLS `USING` clauses FILTER rows rather than raising an error, so an
-- unauthorised UPDATE/DELETE succeeds with zero rows affected. Asserting
-- throws_ok('42501') here would be wrong: no exception is raised. The correct
-- assertion is that the statement completes AND changes nothing.
select lives_ok(
  $$ update public.customers set customer_name = 'Hacked'
     where id = 'c0000000-0000-0000-0000-00000000000a' $$,
  'A read-only member update is filtered by RLS rather than raising'
);

select is(
  (select count(*)::int from public.customers where customer_name = 'Hacked'),
  0,
  'A read-only member cannot update a customer'
);

select lives_ok(
  $$ delete from public.customers where id = 'c0000000-0000-0000-0000-00000000000a' $$,
  'A read-only member delete is filtered by RLS rather than raising'
);

select is(
  (select count(*)::int from public.customers
   where id = 'c0000000-0000-0000-0000-00000000000a'),
  1,
  'A read-only member cannot delete a customer'
);

-- Collection staff may not change owner permissions.
set local request.jwt.claims = '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';

select lives_ok(
  $$ update public.business_members set role = 'owner'
     where user_id = '44444444-4444-4444-4444-444444444444' $$,
  'Collection staff self-promotion is filtered by RLS rather than raising'
);

select is(
  (select role::text from public.business_members
   where user_id = '44444444-4444-4444-4444-444444444444'),
  'collection_staff',
  'Collection staff cannot promote themselves to owner'
);

select throws_ok(
  $$ insert into public.business_members (business_id, user_id, role)
     values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'admin') $$,
  '42501',
  null,
  'Collection staff cannot add members'
);

-- An ADMIN must not be able to promote themselves to owner. This is the real
-- escalation path: can_manage_business() is true for both owner and admin, so
-- without the explicit role check in the policy an admin could seize the
-- business. The collection_staff test above does not cover this case.
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into public.business_members (business_id, user_id, role, invitation_status)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '55555555-5555-5555-5555-555555555555', 'admin', 'accepted');

set local request.jwt.claims = '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}';

select throws_ok(
  $$ update public.business_members set role = 'owner'
     where user_id = '55555555-5555-5555-5555-555555555555' $$,
  '42501',
  null,
  'An admin cannot promote themselves to owner'
);

select is(
  (select role::text from public.business_members
   where user_id = '55555555-5555-5555-5555-555555555555'),
  'admin',
  'The admin role is unchanged after the rejected escalation'
);

-- An admin may still manage non-owner roles.
select lives_ok(
  $$ update public.business_members set role = 'accountant'
     where user_id = '44444444-4444-4444-4444-444444444444' $$,
  'An admin can change a non-owner role'
);

-- Restore collection_staff for the remaining tests.
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
update public.business_members set role = 'collection_staff'
where user_id = '44444444-4444-4444-4444-444444444444';

-- The last owner cannot demote themselves, which would leave the business
-- ownerless and unmanageable.
select throws_ok(
  $$ update public.business_members set role = 'admin'
     where user_id = '11111111-1111-1111-1111-111111111111' $$,
  '22023',
  null,
  'The last owner cannot demote themselves'
);

-- A direct business insert must be impossible: it would create an orphan
-- business with no owner, invisible to every user and unaudited.
select throws_ok(
  $$ insert into public.businesses (legal_name, display_name)
     values ('Orphan Co', 'Orphan Co') $$,
  '42501',
  null,
  'A business cannot be created outside create_business_with_owner'
);

-- ===========================================================================
-- 5. Financial invariants — invoice numbering, totals, allocation
-- ===========================================================================
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select is(
  public.next_invoice_number('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-27'),
  'ALP-2026-27-001',
  'The first invoice number of a financial year is 001'
);

select is(
  public.next_invoice_number('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-27'),
  'ALP-2026-27-002',
  'Invoice numbers increment atomically'
);

select is(
  public.next_invoice_number('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2027-28'),
  'ALP-2027-28-001',
  'A new financial year restarts numbering'
);

-- Create a draft invoice: 2 x ₹500 @ 18% intra-state = ₹1,180
select lives_ok(
  $$ select public.create_invoice(
       'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
       'c0000000-0000-0000-0000-00000000000a',
       '2026-10-01', '2026-10-31', 'intra_state', '24',
       '[{"description":"Widget","quantity":2,"unit_price_paise":50000,"tax_rate_basis_points":1800}]'::jsonb,
       null, 'ALP-TEST-001'
     ) $$,
  'An owner can create a draft invoice'
);

select is(
  (select total_amount_paise from public.invoices where invoice_number = 'ALP-TEST-001'),
  118000::numeric,
  'Server-side totals are exact: 2 x ₹500 + 18% GST = ₹1,180'
);

select is(
  (select cgst_paise from public.invoices where invoice_number = 'ALP-TEST-001'),
  9000::numeric,
  'Intra-state CGST is 9% of the taxable value'
);

select is(
  (select igst_paise from public.invoices where invoice_number = 'ALP-TEST-001'),
  0::numeric,
  'Intra-state invoices carry no IGST'
);

-- Issue the invoice.
select lives_ok(
  $$ select public.issue_invoice((select id from public.invoices where invoice_number = 'ALP-TEST-001')) $$,
  'A draft invoice can be issued'
);

select is(
  (select document_state::text from public.invoices where invoice_number = 'ALP-TEST-001'),
  'issued',
  'The invoice is issued'
);

select isnt(
  (select customer_snapshot from public.invoices where invoice_number = 'ALP-TEST-001'),
  null,
  'Issuing snapshots the customer details'
);

-- Issued invoices are financially frozen.
select throws_ok(
  $$ update public.invoices set total_amount_paise = 1
     where invoice_number = 'ALP-TEST-001' $$,
  '22023',
  null,
  'An issued invoice total cannot be edited'
);

-- Record a partial payment of ₹500 allocated to the invoice.
select lives_ok(
  $$ select public.record_payment(
       'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
       'c0000000-0000-0000-0000-00000000000a',
       '2026-10-05', 50000, 'upi', 'UPI-REF-1', 'idem-key-0001', null,
       jsonb_build_array(jsonb_build_object(
         'invoice_id', (select id from public.invoices where invoice_number = 'ALP-TEST-001'),
         'amount_paise', 50000
       ))
     ) $$,
  'A partial payment can be recorded and allocated'
);

select is(
  (select outstanding_paise from public.invoice_balances where invoice_number = 'ALP-TEST-001'),
  68000::numeric,
  'Outstanding balance is total minus allocated payments'
);

-- Idempotency: the same key must not create a second payment.
select is(
  (select public.record_payment(
       'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
       'c0000000-0000-0000-0000-00000000000a',
       '2026-10-05', 50000, 'upi', 'UPI-REF-1', 'idem-key-0001', null, '[]'::jsonb
     )),
  (select id from public.payments where idempotency_key = 'idem-key-0001'),
  'A repeated idempotency key returns the original payment'
);

select is(
  (select count(*)::int from public.payments where idempotency_key = 'idem-key-0001'),
  1,
  'Duplicate payment submissions are prevented'
);

-- Over-allocation is rejected.
select throws_ok(
  $$ select public.record_payment(
       'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
       'c0000000-0000-0000-0000-00000000000a',
       '2026-10-06', 100000, 'cash', null, 'idem-key-0002', null,
       jsonb_build_array(jsonb_build_object(
         'invoice_id', (select id from public.invoices where invoice_number = 'ALP-TEST-001'),
         'amount_paise', 100000
       ))
     ) $$,
  '22023',
  null,
  'An allocation larger than the outstanding balance is rejected'
);

-- Overpayment without allocation becomes an advance.
select lives_ok(
  $$ select public.record_payment(
       'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
       'c0000000-0000-0000-0000-00000000000a',
       '2026-10-07', 200000, 'cash', null, 'idem-key-0003', null, '[]'::jsonb
     ) $$,
  'An unallocated payment (advance) can be recorded'
);

select is(
  (select unallocated_paise from public.payment_balances where payment_id = (
     select id from public.payments where idempotency_key = 'idem-key-0003'
   )),
  200000::numeric,
  'The advance payment reports its full amount as unallocated'
);

-- ===========================================================================
-- 5b. Invoice immutability — an issued invoice cannot be reverted to draft
-- ===========================================================================
select throws_ok(
  $$ update public.invoices set document_state = 'draft'
     where invoice_number = 'ALP-TEST-001' $$,
  '22023',
  null,
  'An issued invoice cannot be returned to draft'
);

select is(
  (select document_state::text from public.invoices where invoice_number = 'ALP-TEST-001'),
  'issued',
  'The invoice is still issued after the rejected revert'
);

-- Line items of an issued invoice are frozen.
select throws_ok(
  $$ update public.invoice_items set description = 'Tampered'
     where invoice_id = (select id from public.invoices where invoice_number = 'ALP-TEST-001') $$,
  '22023',
  null,
  'Line items of an issued invoice cannot be edited'
);

-- ===========================================================================
-- 5c. Payment reversal
-- ===========================================================================
-- Reversing the ₹500 payment must restore the invoice balance to the full
-- ₹1,180 and must not delete the payment row.
select lives_ok(
  $$ select public.reverse_payment(
       (select id from public.payments where idempotency_key = 'idem-key-0001'),
       'Cheque bounced'
     ) $$,
  'An owner can reverse a payment'
);

select is(
  (select outstanding_paise from public.invoice_balances where invoice_number = 'ALP-TEST-001'),
  118000::numeric,
  'Reversing a payment restores the full outstanding balance'
);

select isnt(
  (select reversed_at from public.payments where idempotency_key = 'idem-key-0001'),
  null,
  'The reversed payment row is preserved, not deleted'
);

select throws_ok(
  $$ select public.reverse_payment(
       (select id from public.payments where idempotency_key = 'idem-key-0001'),
       'Again'
     ) $$,
  '22023',
  null,
  'A payment cannot be reversed twice'
);

select throws_ok(
  $$ select public.reverse_payment(
       (select id from public.payments where idempotency_key = 'idem-key-0003'),
       '   '
     ) $$,
  '22023',
  null,
  'A reversal requires a non-blank reason'
);

-- ===========================================================================
-- 5d. Voiding
-- ===========================================================================
-- The invoice now has no live allocations, so it can be voided.
select lives_ok(
  $$ select public.void_invoice(
       (select id from public.invoices where invoice_number = 'ALP-TEST-001'),
       'Raised in error'
     ) $$,
  'An invoice with no live allocations can be voided'
);

select is(
  (select document_state::text from public.invoices where invoice_number = 'ALP-TEST-001'),
  'void',
  'The invoice is void'
);

select throws_ok(
  $$ select public.void_invoice(
       (select id from public.invoices where invoice_number = 'ALP-TEST-001'),
       'Twice'
     ) $$,
  '22023',
  null,
  'An invoice cannot be voided twice'
);

select throws_ok(
  $$ update public.invoices set document_state = 'issued'
     where invoice_number = 'ALP-TEST-001' $$,
  '22023',
  null,
  'A void invoice cannot be reinstated'
);

-- ===========================================================================
-- 6. Audit trail
-- ===========================================================================
select cmp_ok(
  (select count(*)::int from public.audit_logs
   where business_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
     and action in ('invoice.created', 'invoice.issued', 'payment.recorded')),
  '>=',
  3,
  'Financial actions are written to the audit log'
);

-- audit_logs has no UPDATE/DELETE policy at all, so RLS filters every row and
-- the append-only trigger never fires. The statement therefore succeeds while
-- changing nothing. Assert the outcome, not an exception.
--
-- Note: 'invoice.voided' rows legitimately exist by this point (the void test
-- above created one), so we compare the row count before and after instead of
-- asserting the action is absent.
select cmp_ok(
  (select count(*)::int from public.audit_logs
   where business_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  '>=',
  3,
  'Audit history exists before the modification attempt'
);

select lives_ok(
  $$ update public.audit_logs set action = 'invoice.voided' $$,
  'An audit_logs update is filtered by RLS rather than raising'
);

select is(
  (select count(*)::int from public.audit_logs
   where business_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
     and action = 'invoice.voided'),
  1,
  'Audit history cannot be modified'
);

select lives_ok(
  $$ delete from public.audit_logs $$,
  'An audit_logs delete is filtered by RLS rather than raising'
);

select cmp_ok(
  (select count(*)::int from public.audit_logs
   where business_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  '>=',
  3,
  'Audit history cannot be deleted'
);

-- ===========================================================================
-- 7. Cross-tenant financial operations are rejected
-- ===========================================================================
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

select throws_ok(
  $$ select public.create_invoice(
       'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
       'c0000000-0000-0000-0000-00000000000a',
       '2026-10-01', '2026-10-31', 'intra_state', '24',
       '[{"description":"Injected","quantity":1,"unit_price_paise":100}]'::jsonb
     ) $$,
  '42501',
  null,
  'Business B cannot create an invoice in Business A'
);

select throws_ok(
  $$ select public.record_payment(
       'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
       'c0000000-0000-0000-0000-00000000000a',
       '2026-10-05', 1000, 'cash', null, 'idem-cross-tenant', null, '[]'::jsonb
     ) $$,
  '42501',
  null,
  'Business B cannot record a payment in Business A'
);

select is(
  (select count(*)::int from public.invoices where business_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  0,
  'Business B cannot read Business A invoices'
);

select is(
  (select count(*)::int from public.payments where business_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  0,
  'Business B cannot read Business A payments'
);

select * from finish();
rollback;
