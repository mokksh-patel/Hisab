-- ===========================================================================
-- BizPilot — pgTAP tests for migration 0005 (invoice engine v2)
--
-- Covers: GST-inclusive pricing, fixed discounts, invoice-level discounts,
-- GST scheme guards, backwards compatibility of the legacy 9-argument
-- create_invoice() signature, and immutability of the new columns.
--
-- Run with:  supabase test db
-- ===========================================================================

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(170);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
do $$
declare
  v_columns text;
  v_values text;
  v_unhandled text;
begin
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
    raise exception 'auth.users has required column(s) this fixture does not handle: %', v_unhandled;
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
       (''c1111111-1111-1111-1111-111111111111''::uuid, ''v2-owner@example.test''),
       (''c2222222-2222-2222-2222-222222222222''::uuid, ''v2-readonly@example.test''),
       (''c3333333-3333-3333-3333-333333333333''::uuid, ''v2-other@example.test'')
     ) as u(id, email)',
    v_columns, v_values
  );
end;
$$;

insert into public.businesses (id, legal_name, display_name, state_code, invoice_prefix, is_gst_registered, gst_scheme)
values
  ('c0000000-0000-0000-0000-00000000000a', 'V2 Regular Pvt Ltd', 'V2 Regular', '24', 'V2R', true, 'regular'),
  -- A composition taxpayer IS GST-registered; it simply may not collect GST.
  ('c0000000-0000-0000-0000-00000000000b', 'V2 Composition LLP', 'V2 Composition', '24', 'V2C', true, 'composition'),
  ('c0000000-0000-0000-0000-00000000000c', 'V2 Unregistered', 'V2 Unregistered', '24', 'V2U', false, 'unregistered'),
  -- A business whose scheme was inferred during migration and not yet confirmed.
  ('c0000000-0000-0000-0000-00000000000d', 'V2 Unconfirmed', 'V2 Unconfirmed', '24', 'V2X', true, 'regular');

update public.businesses
set gst_scheme_needs_review = true
where id = 'c0000000-0000-0000-0000-00000000000d';

insert into public.business_members (business_id, user_id, role, invitation_status)
values
  ('c0000000-0000-0000-0000-00000000000a', 'c1111111-1111-1111-1111-111111111111', 'owner', 'accepted'),
  ('c0000000-0000-0000-0000-00000000000b', 'c1111111-1111-1111-1111-111111111111', 'owner', 'accepted'),
  ('c0000000-0000-0000-0000-00000000000c', 'c1111111-1111-1111-1111-111111111111', 'owner', 'accepted'),
  ('c0000000-0000-0000-0000-00000000000d', 'c1111111-1111-1111-1111-111111111111', 'owner', 'accepted'),
  -- A read-only member of business A, for the authorization tests.
  ('c0000000-0000-0000-0000-00000000000a', 'c2222222-2222-2222-2222-222222222222', 'read_only', 'accepted'),
  -- An owner of a different business, who must not reach business A.
  ('c0000000-0000-0000-0000-00000000000b', 'c3333333-3333-3333-3333-333333333333', 'owner', 'accepted');

insert into public.customers (id, business_id, customer_name, state_code)
values
  ('c0000000-0000-0000-0000-0000000000c1', 'c0000000-0000-0000-0000-00000000000a', 'V2 Customer', '24'),
  ('c0000000-0000-0000-0000-0000000000c2', 'c0000000-0000-0000-0000-00000000000b', 'V2 Comp Customer', '24'),
  ('c0000000-0000-0000-0000-0000000000c3', 'c0000000-0000-0000-0000-00000000000c', 'V2 Unreg Customer', '24'),
  ('c0000000-0000-0000-0000-0000000000c4', 'c0000000-0000-0000-0000-00000000000d', 'V2 Unconfirmed Customer', '24');

set local role authenticated;
set local request.jwt.claims = '{"sub":"c1111111-1111-1111-1111-111111111111","role":"authenticated"}';

-- ===========================================================================
-- 1. GST-exclusive pricing (legacy behaviour must be unchanged)
-- ===========================================================================
select lives_ok(
  $$ select public.create_invoice(
       'c0000000-0000-0000-0000-00000000000a',
       'c0000000-0000-0000-0000-0000000000c1',
       '2026-10-01', '2026-10-31', 'intra_state', '24',
       '[{"description":"Widget","quantity":"10","unit_price_paise":"50000","tax_rate_basis_points":1800}]'::jsonb,
       null, 'V2-EXCL-001'
     ) $$,
  'exclusive invoice can be created'
);

select is(
  (select total_amount_paise from public.invoices where invoice_number = 'V2-EXCL-001'),
  590000::numeric,
  'exclusive: 10 x Rs500 + 18% = Rs5,900'
);

select is(
  (select taxable_amount_paise from public.invoices where invoice_number = 'V2-EXCL-001'),
  500000::numeric,
  'exclusive: taxable value is Rs5,000'
);

select is(
  (select cgst_paise from public.invoices where invoice_number = 'V2-EXCL-001'),
  45000::numeric,
  'exclusive: CGST is Rs450'
);

select is(
  (select price_includes_tax from public.invoices where invoice_number = 'V2-EXCL-001'),
  false,
  'exclusive invoice records price_includes_tax = false'
);

-- ===========================================================================
-- 2. GST-inclusive pricing
-- ===========================================================================
select lives_ok(
  $$ select public.create_invoice(
       'c0000000-0000-0000-0000-00000000000a',
       'c0000000-0000-0000-0000-0000000000c1',
       '2026-10-01', '2026-10-31', 'intra_state', '24',
       '[{"description":"Widget","quantity":"10","unit_price_paise":"50000","tax_rate_basis_points":1800}]'::jsonb,
       null, 'V2-INCL-001', true, 0
     ) $$,
  'inclusive invoice can be created'
);

select is(
  (select total_amount_paise from public.invoices where invoice_number = 'V2-INCL-001'),
  500000::numeric,
  'inclusive: customer pays exactly Rs5,000'
);

select is(
  (select taxable_amount_paise from public.invoices where invoice_number = 'V2-INCL-001'),
  423729::numeric,
  'inclusive: taxable value back-solved to Rs4,237.29'
);

select is(
  (select total_tax_paise from public.invoices where invoice_number = 'V2-INCL-001'),
  76271::numeric,
  'inclusive: GST is Rs762.71'
);

select is(
  (select taxable_amount_paise + total_tax_paise from public.invoices where invoice_number = 'V2-INCL-001'),
  (select total_amount_paise from public.invoices where invoice_number = 'V2-INCL-001'),
  'inclusive: taxable + tax reconciles exactly to the total'
);

select is(
  (select cgst_paise + sgst_paise from public.invoices where invoice_number = 'V2-INCL-001'),
  (select total_tax_paise from public.invoices where invoice_number = 'V2-INCL-001'),
  'inclusive: CGST + SGST equals total tax'
);

-- ===========================================================================
-- 3. Fixed discounts
-- ===========================================================================
select lives_ok(
  $$ select public.create_invoice(
       'c0000000-0000-0000-0000-00000000000a',
       'c0000000-0000-0000-0000-0000000000c1',
       '2026-10-01', '2026-10-31', 'intra_state', '24',
       '[{"description":"Widget","quantity":"1","unit_price_paise":"100000","tax_rate_basis_points":1800,
          "discount_type":"fixed","discount_value":"15000"}]'::jsonb,
       null, 'V2-FIXED-001'
     ) $$,
  'fixed-discount invoice can be created'
);

select is(
  (select discount_paise from public.invoices where invoice_number = 'V2-FIXED-001'),
  15000::numeric,
  'fixed discount of Rs150 is recorded'
);

select is(
  (select taxable_amount_paise from public.invoices where invoice_number = 'V2-FIXED-001'),
  85000::numeric,
  'fixed discount reduces the taxable value to Rs850'
);

select is(
  (select discount_type::text from public.invoice_items
    where invoice_id = (select id from public.invoices where invoice_number = 'V2-FIXED-001')),
  'fixed',
  'line records discount_type = fixed'
);

select throws_ok(
  $$ select public.create_invoice(
       'c0000000-0000-0000-0000-00000000000a',
       'c0000000-0000-0000-0000-0000000000c1',
       '2026-10-01', '2026-10-31', 'intra_state', '24',
       '[{"description":"Widget","quantity":"1","unit_price_paise":"1000","tax_rate_basis_points":1800,
          "discount_type":"fixed","discount_value":"2000"}]'::jsonb,
       null, 'V2-FIXED-BAD'
     ) $$,
  '22023',
  null,
  'a fixed discount larger than the line amount is rejected'
);

-- ===========================================================================
-- 4. Invoice-level discount
-- ===========================================================================
select lives_ok(
  $$ select public.create_invoice(
       'c0000000-0000-0000-0000-00000000000a',
       'c0000000-0000-0000-0000-0000000000c1',
       '2026-10-01', '2026-10-31', 'intra_state', '24',
       '[{"description":"Widget","quantity":"1","unit_price_paise":"100000","tax_rate_basis_points":1800}]'::jsonb,
       null, 'V2-INVDISC-001', false, 10000
     ) $$,
  'invoice-level discount can be applied'
);

select is(
  (select invoice_discount_paise from public.invoices where invoice_number = 'V2-INVDISC-001'),
  10000::numeric,
  'invoice discount of Rs100 is recorded separately'
);

select is(
  (select taxable_amount_paise from public.invoices where invoice_number = 'V2-INVDISC-001'),
  90000::numeric,
  'invoice discount reduces the taxable value to Rs900'
);

select is(
  (select total_amount_paise from public.invoices where invoice_number = 'V2-INVDISC-001'),
  106200::numeric,
  'invoice discount: total is Rs1,062 (900 + 18% tax)'
);

select throws_ok(
  $$ select public.create_invoice(
       'c0000000-0000-0000-0000-00000000000a',
       'c0000000-0000-0000-0000-0000000000c1',
       '2026-10-01', '2026-10-31', 'intra_state', '24',
       '[{"description":"Widget","quantity":"1","unit_price_paise":"1000","tax_rate_basis_points":1800}]'::jsonb,
       null, 'V2-INVDISC-BAD', false, 5000
     ) $$,
  '22023',
  null,
  'an invoice discount larger than the taxable value is rejected'
);

-- ===========================================================================
-- 5. GST scheme guards
-- ===========================================================================
select is(
  (select is_gst_registered from public.businesses where id = 'c0000000-0000-0000-0000-00000000000b'),
  true,
  'a composition taxpayer IS GST-registered'
);

select throws_ok(
  $$ insert into public.businesses (legal_name, display_name, is_gst_registered, gst_scheme)
     values ('Bad Co', 'Bad Co', false, 'composition') $$,
  '23514',
  null,
  'composition scheme with is_gst_registered = false is rejected by the constraint'
);

select throws_ok(
  $$ insert into public.businesses (legal_name, display_name, is_gst_registered, gst_scheme)
     values ('Bad Co 2', 'Bad Co 2', false, 'regular') $$,
  '23514',
  null,
  'regular scheme with is_gst_registered = false is rejected by the constraint'
);

select throws_ok(
  $$ select public.create_invoice(
       'c0000000-0000-0000-0000-00000000000b',
       'c0000000-0000-0000-0000-0000000000c2',
       '2026-10-01', '2026-10-31', 'intra_state', '24',
       '[{"description":"Widget","quantity":"1","unit_price_paise":"1000","tax_rate_basis_points":1800}]'::jsonb
     ) $$,
  '22023',
  null,
  'a composition business cannot issue a tax invoice'
);

-- A composition business MAY record a genuinely exempt supply: exemption is a
-- property of the goods or services, not of the business's registration scheme.
-- Blocking exempt supplies for composition taxpayers would be wrong.
--
-- What a composition business must not do is record its own composition
-- turnover as "exempt" — that turnover is taxable at a flat rate. That is a
-- business-process rule surfaced in the UI, not something the database can
-- infer from p_gst_mode alone.
select lives_ok(
  $$ select public.create_invoice(
       'c0000000-0000-0000-0000-00000000000b',
       'c0000000-0000-0000-0000-0000000000c2',
       '2026-10-01', '2026-10-31', 'exempt', '24',
       '[{"description":"Widget","quantity":"1","unit_price_paise":"1000","tax_rate_basis_points":0}]'::jsonb,
       null, 'V2-COMP-EXEMPT'
     ) $$,
  'a composition business may record a genuinely exempt supply'
);

select is(
  (select total_tax_paise from public.invoices where invoice_number = 'V2-COMP-EXEMPT'),
  0::numeric,
  'the exempt invoice carries no tax'
);

select throws_ok(
  $$ select public.create_invoice(
       'c0000000-0000-0000-0000-00000000000c',
       'c0000000-0000-0000-0000-0000000000c3',
       '2026-10-01', '2026-10-31', 'intra_state', '24',
       '[{"description":"Widget","quantity":"1","unit_price_paise":"1000","tax_rate_basis_points":1800}]'::jsonb
     ) $$,
  '22023',
  null,
  'an unregistered business cannot charge GST'
);

-- ===========================================================================
-- 5b. Unconfirmed GST scheme is rejected server-side
-- ===========================================================================
select throws_ok(
  $$ select public.create_invoice(
       'c0000000-0000-0000-0000-00000000000d',
       'c0000000-0000-0000-0000-0000000000c4',
       '2026-10-01', '2026-10-31', 'intra_state', '24',
       '[{"description":"Widget","quantity":"1","unit_price_paise":"1000","tax_rate_basis_points":1800}]'::jsonb
     ) $$,
  '22023',
  null,
  'an unconfirmed GST scheme blocks tax-invoice issuance'
);

select lives_ok(
  $$ select public.confirm_gst_scheme('c0000000-0000-0000-0000-00000000000d', 'regular') $$,
  'the owner can confirm the GST scheme'
);

select is(
  (select gst_scheme_needs_review from public.businesses where id = 'c0000000-0000-0000-0000-00000000000d'),
  false,
  'confirming the scheme clears the review flag'
);

select lives_ok(
  $$ select public.create_invoice(
       'c0000000-0000-0000-0000-00000000000d',
       'c0000000-0000-0000-0000-0000000000c4',
       '2026-10-01', '2026-10-31', 'intra_state', '24',
       '[{"description":"Widget","quantity":"1","unit_price_paise":"1000","tax_rate_basis_points":1800}]'::jsonb,
       null, 'V2-CONFIRMED-001'
     ) $$,
  'a tax invoice can be issued after the scheme is confirmed'
);

-- ===========================================================================
-- 6. Backwards compatibility
-- ===========================================================================
select lives_ok(
  $$ select public.create_invoice(
       'c0000000-0000-0000-0000-00000000000a',
       'c0000000-0000-0000-0000-0000000000c1',
       '2026-10-01', '2026-10-31', 'intra_state', '24',
       '[{"description":"Legacy","quantity":"2","unit_price_paise":"50000",
          "discount_percent_basis_points":1000,"tax_rate_basis_points":1800}]'::jsonb,
       null, 'V2-LEGACY-001'
     ) $$,
  'the legacy 9-argument signature still works'
);

select is(
  (select discount_paise from public.invoices where invoice_number = 'V2-LEGACY-001'),
  10000::numeric,
  'legacy percentage discount is still applied (10% of Rs1,000)'
);

select is(
  (select discount_type::text from public.invoice_items
    where invoice_id = (select id from public.invoices where invoice_number = 'V2-LEGACY-001')),
  'percent',
  'legacy percentage discount is recorded as discount_type = percent'
);

-- ===========================================================================
-- 7. Immutability of the new columns on issued invoices
-- ===========================================================================
select lives_ok(
  $$ select public.issue_invoice((select id from public.invoices where invoice_number = 'V2-EXCL-001')) $$,
  'invoice can be issued'
);

select throws_ok(
  $$ update public.invoices set price_includes_tax = true
     where invoice_number = 'V2-EXCL-001' $$,
  '22023',
  null,
  'price_includes_tax cannot change on an issued invoice'
);

select throws_ok(
  $$ update public.invoices set invoice_discount_paise = 5000
     where invoice_number = 'V2-EXCL-001' $$,
  '22023',
  null,
  'invoice_discount_paise cannot change on an issued invoice'
);

-- The guard must also block changes that leave the aggregate total unchanged
-- but move value between components, or flip the tax mode.
select throws_ok(
  $$ update public.invoices
     set gst_mode = 'inter_state'
     where invoice_number = 'V2-EXCL-001' $$,
  '22023',
  null,
  'gst_mode cannot change on an issued invoice'
);

select throws_ok(
  $$ update public.invoices
     set place_of_supply_state_code = '27'
     where invoice_number = 'V2-EXCL-001' $$,
  '22023',
  null,
  'place_of_supply_state_code cannot change on an issued invoice'
);

select throws_ok(
  $$ update public.invoices
     set cgst_paise = cgst_paise + 100, sgst_paise = sgst_paise - 100
     where invoice_number = 'V2-EXCL-001' $$,
  '22023',
  null,
  'tax components cannot be shifted between each other on an issued invoice'
);

select throws_ok(
  $$ update public.invoices
     set due_date = due_date + 1
     where invoice_number = 'V2-EXCL-001' $$,
  '22023',
  null,
  'due_date cannot change on an issued invoice'
);

-- Moving an issued invoice to another tenant would be a cross-tenant breach.
select throws_ok(
  $$ update public.invoices
     set business_id = 'c0000000-0000-0000-0000-00000000000b'
     where invoice_number = 'V2-EXCL-001' $$,
  '22023',
  null,
  'business_id cannot change on an issued invoice'
);

-- ===========================================================================
-- 7b. Lifecycle and attribution fields
--
--   These are NOT compared in guard_invoice_update(). They are protected by
--   other mechanisms, and the tests below prove each one actually holds.
--
--   id            primary key; no code path updates it. A direct UPDATE is
--                 possible in SQL but would break every foreign key, so it is
--                 not a realistic attack surface. Asserted below for completeness.
--   document_state governed by guard_invoice_update() transitions.
--   issued_at     tied to document_state by invoices_issued_requires_timestamp.
--   voided_at     tied to document_state by invoices_void_requires_reason.
--   void_reason   tied to document_state by invoices_void_requires_reason.
--   created_by    written once at creation; never updated by any function.
--   created_at    written once at creation; never updated by any function.
--
--   A dedicated invoice is used so the void below does not disturb the
--   V2-EXCL-001 assertions that follow.
-- ===========================================================================
select lives_ok(
  $$ select public.create_invoice(
       'c0000000-0000-0000-0000-00000000000a',
       'c0000000-0000-0000-0000-0000000000c1',
       '2026-10-01', '2026-10-31', 'intra_state', '24',
       '[{"description":"Lifecycle","quantity":"1","unit_price_paise":"10000","tax_rate_basis_points":1800}]'::jsonb,
       null, 'V2-LIFECYCLE-001'
     ) $$,
  'a lifecycle test invoice is created'
);

select lives_ok(
  $$ select public.issue_invoice((select id from public.invoices where invoice_number = 'V2-LIFECYCLE-001')) $$,
  'the lifecycle test invoice is issued'
);

-- document_state: issued -> draft is rejected by the guard.
select throws_ok(
  $$ update public.invoices set document_state = 'draft'
     where invoice_number = 'V2-LIFECYCLE-001' $$,
  '22023',
  null,
  'document_state cannot go from issued back to draft'
);

-- issued_at: clearing it on an issued invoice violates the timestamp constraint.
select throws_ok(
  $$ update public.invoices set issued_at = null
     where invoice_number = 'V2-LIFECYCLE-001' $$,
  '23514',
  null,
  'issued_at cannot be cleared while the invoice is issued'
);

-- voided_at / void_reason: setting them without moving to void violates the
-- void-reason constraint.
select throws_ok(
  $$ update public.invoices set voided_at = now()
     where invoice_number = 'V2-LIFECYCLE-001' $$,
  '23514',
  null,
  'voided_at cannot be set on a non-void invoice'
);

select throws_ok(
  $$ update public.invoices set void_reason = 'sneaky'
     where invoice_number = 'V2-LIFECYCLE-001' $$,
  '23514',
  null,
  'void_reason cannot be set on a non-void invoice'
);

-- created_by / created_at: no function updates them, and the guard does not
-- need to because nothing writes them after creation. Assert the values are
-- stable across a permitted lifecycle transition (issue -> void).
select is(
  (select created_by from public.invoices where invoice_number = 'V2-LIFECYCLE-001'),
  'c1111111-1111-1111-1111-111111111111'::uuid,
  'created_by is the user who created the invoice'
);

-- A valid void must still work, and must not disturb created_by/created_at.
select lives_ok(
  $$ select public.void_invoice(
       (select id from public.invoices where invoice_number = 'V2-LIFECYCLE-001'),
       'test void'
     ) $$,
  'a valid void still succeeds'
);

select is(
  (select document_state::text from public.invoices where invoice_number = 'V2-LIFECYCLE-001'),
  'void',
  'the invoice is void after the valid void'
);

select is(
  (select created_by from public.invoices where invoice_number = 'V2-LIFECYCLE-001'),
  'c1111111-1111-1111-1111-111111111111'::uuid,
  'created_by is unchanged by the void'
);

select isnt(
  (select voided_at from public.invoices where invoice_number = 'V2-LIFECYCLE-001'),
  null,
  'voided_at is set by the void'
);

select is(
  (select void_reason from public.invoices where invoice_number = 'V2-LIFECYCLE-001'),
  'test void',
  'void_reason is recorded by the void'
);

-- A void invoice cannot be reinstated.
select throws_ok(
  $$ update public.invoices set document_state = 'issued'
     where invoice_number = 'V2-LIFECYCLE-001' $$,
  '22023',
  null,
  'a void invoice cannot be reinstated'
);

-- ===========================================================================
-- 7c. Identity and attribution are immutable on EVERY invoice
--
--   These are enforced by guard_invoice_update() on every update, not only on
--   issued invoices. A primary key is not proof of immutability, and
--   created_by/created_at have no CHECK constraint protecting them.
-- ===========================================================================
select throws_ok(
  $$ update public.invoices
     set id = gen_random_uuid()
     where invoice_number = 'V2-LIFECYCLE-001' $$,
  '22023',
  null,
  'invoices.id cannot be changed'
);

select throws_ok(
  $$ update public.invoices
     set created_by = 'c3333333-3333-3333-3333-333333333333'
     where invoice_number = 'V2-LIFECYCLE-001' $$,
  '22023',
  null,
  'created_by cannot be changed'
);

select throws_ok(
  $$ update public.invoices
     set created_at = now() - interval '1 year'
     where invoice_number = 'V2-LIFECYCLE-001' $$,
  '22023',
  null,
  'created_at cannot be changed'
);

-- ===========================================================================
-- 7d. Lifecycle timestamps cannot be rewritten after the transition
-- ===========================================================================
select throws_ok(
  $$ update public.invoices
     set issued_at = issued_at + interval '1 day'
     where invoice_number = 'V2-LIFECYCLE-001' $$,
  '22023',
  null,
  'issued_at cannot be rewritten after issue'
);

select throws_ok(
  $$ update public.invoices
     set voided_at = voided_at + interval '1 day'
     where invoice_number = 'V2-LIFECYCLE-001' $$,
  '22023',
  null,
  'voided_at cannot be rewritten after void'
);

select throws_ok(
  $$ update public.invoices
     set void_reason = 'rewritten'
     where invoice_number = 'V2-LIFECYCLE-001' $$,
  '22023',
  null,
  'void_reason cannot be rewritten after void'
);

-- A draft invoice may still be edited freely (no lifecycle fields set yet).
select lives_ok(
  $$ update public.invoices
     set notes = 'draft note'
     where invoice_number = 'V2-HISTORIC-001' $$,
  'a draft invoice can still be edited'
);

-- ===========================================================================
-- 7e. RPC bypass attempts
--
--   RLS on public.invoices is:
--     invoices_update_writer FOR UPDATE TO authenticated
--       USING (can_write_financials(business_id))
--       WITH CHECK (can_write_financials(business_id))
--
--   RLS checks WHO may update and WHICH ROWS, not WHICH COLUMNS. Migration 0005
--   therefore revokes table-level UPDATE from `authenticated` and grants UPDATE
--   only on the non-lifecycle columns. document_state, issued_at, voided_at and
--   void_reason are NOT granted, so a direct client UPDATE fails with 42501
--   (insufficient_privilege) BEFORE any trigger runs.
--
--   The SECURITY DEFINER functions issue_invoice() / void_invoice() run as the
--   function owner and retain full UPDATE privilege, so the supported
--   workflows are unaffected.
-- ===========================================================================

-- A fresh draft, used to attempt a direct draft -> issued bypass.
select lives_ok(
  $$ select public.create_invoice(
       'c0000000-0000-0000-0000-00000000000a',
       'c0000000-0000-0000-0000-0000000000c1',
       '2026-10-01', '2026-10-31', 'intra_state', '24',
       '[{"description":"Bypass","quantity":"1","unit_price_paise":"10000","tax_rate_basis_points":1800}]'::jsonb,
       null, 'V2-BYPASS-001'
     ) $$,
  'a draft invoice is created for the bypass tests'
);

-- Direct draft -> issued without calling issue_invoice().
-- Rejected by COLUMN PRIVILEGE (42501), not by the trigger.
select throws_ok(
  $$ update public.invoices
     set document_state = 'issued', issued_at = now()
     where invoice_number = 'V2-BYPASS-001' $$,
  '42501',
  null,
  'a direct draft-to-issued UPDATE is denied by column privilege'
);

select is(
  (select document_state::text from public.invoices where invoice_number = 'V2-BYPASS-001'),
  'draft',
  'the invoice is still a draft after the rejected bypass'
);

select is(
  (select issued_at from public.invoices where invoice_number = 'V2-BYPASS-001'),
  null,
  'issued_at is still null after the rejected bypass'
);

-- The legitimate RPC must still work.
select lives_ok(
  $$ select public.issue_invoice((select id from public.invoices where invoice_number = 'V2-BYPASS-001')) $$,
  'issue_invoice() still issues the invoice'
);

select is(
  (select document_state::text from public.invoices where invoice_number = 'V2-BYPASS-001'),
  'issued',
  'the invoice is issued after the RPC'
);

select isnt(
  (select issued_at from public.invoices where invoice_number = 'V2-BYPASS-001'),
  null,
  'issued_at is set by the RPC'
);

-- Direct issued -> void without calling void_invoice().
select throws_ok(
  $$ update public.invoices
     set document_state = 'void', voided_at = now(), void_reason = 'bypass'
     where invoice_number = 'V2-BYPASS-001' $$,
  '42501',
  null,
  'a direct issued-to-void UPDATE is denied by column privilege'
);

select is(
  (select document_state::text from public.invoices where invoice_number = 'V2-BYPASS-001'),
  'issued',
  'the invoice is still issued after the rejected void bypass'
);

select is(
  (select voided_at from public.invoices where invoice_number = 'V2-BYPASS-001'),
  null,
  'voided_at is still null after the rejected void bypass'
);

-- The legitimate RPC must still work.
select lives_ok(
  $$ select public.void_invoice(
       (select id from public.invoices where invoice_number = 'V2-BYPASS-001'),
       'legitimate void'
     ) $$,
  'void_invoice() still voids the invoice'
);

select is(
  (select document_state::text from public.invoices where invoice_number = 'V2-BYPASS-001'),
  'void',
  'the invoice is void after the RPC'
);

select is(
  (select void_reason from public.invoices where invoice_number = 'V2-BYPASS-001'),
  'legitimate void',
  'void_reason is recorded by the RPC'
);

-- A non-lifecycle column is ALSO not directly writable: the application has no
-- direct .update() on public.invoices, so no client role has any write
-- privilege on the table.
select throws_ok(
  $$ update public.invoices
     set notes = 'still writable'
     where invoice_number = 'V2-HISTORIC-001' $$,
  '42501',
  null,
  'no column of public.invoices is directly writable by authenticated'
);

-- Direct INSERT is denied.
select throws_ok(
  $$ insert into public.invoices (business_id, customer_id, invoice_number, financial_year, invoice_date, due_date)
     values ('c0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-0000000000c1',
             'V2-DIRECT-INSERT', '2026-27', '2026-10-01', '2026-10-31') $$,
  '42501',
  null,
  'a direct INSERT into public.invoices is denied'
);

-- Direct DELETE is denied.
select throws_ok(
  $$ delete from public.invoices where invoice_number = 'V2-HISTORIC-001' $$,
  '42501',
  null,
  'a direct DELETE from public.invoices is denied'
);

-- ===========================================================================
-- 7f. Effective privilege audit
--
--   These assert the EFFECTIVE privilege via has_table_privilege() and
--   has_column_privilege(), not merely the presence of GRANT/REVOKE statements.
-- ===========================================================================
select is(
  has_table_privilege('authenticated', 'public.invoices', 'SELECT'),
  true,
  'authenticated: SELECT = true'
);

select is(
  has_table_privilege('authenticated', 'public.invoices', 'INSERT'),
  false,
  'authenticated: INSERT = false'
);

select is(
  has_table_privilege('authenticated', 'public.invoices', 'UPDATE'),
  false,
  'authenticated: UPDATE = false'
);

select is(
  has_table_privilege('authenticated', 'public.invoices', 'DELETE'),
  false,
  'authenticated: DELETE = false'
);

select is(
  has_table_privilege('anon', 'public.invoices', 'SELECT'),
  false,
  'anon: SELECT = false'
);

select is(
  has_table_privilege('anon', 'public.invoices', 'INSERT'),
  false,
  'anon: INSERT = false'
);

select is(
  has_table_privilege('anon', 'public.invoices', 'UPDATE'),
  false,
  'anon: UPDATE = false'
);

select is(
  has_table_privilege('anon', 'public.invoices', 'DELETE'),
  false,
  'anon: DELETE = false'
);

-- PUBLIC must hold nothing on the table.
select is(
  has_table_privilege('public', 'public.invoices', 'SELECT'),
  false,
  'PUBLIC: SELECT = false'
);

select is(
  has_table_privilege('public', 'public.invoices', 'INSERT'),
  false,
  'PUBLIC: INSERT = false'
);

select is(
  has_table_privilege('public', 'public.invoices', 'UPDATE'),
  false,
  'PUBLIC: UPDATE = false'
);

select is(
  has_table_privilege('public', 'public.invoices', 'DELETE'),
  false,
  'PUBLIC: DELETE = false'
);

-- Column-level: no client role may write any lifecycle or financial column.
select is(
  has_column_privilege('authenticated', 'public.invoices', 'document_state', 'UPDATE'),
  false,
  'authenticated: no UPDATE on document_state'
);

select is(
  has_column_privilege('authenticated', 'public.invoices', 'issued_at', 'UPDATE'),
  false,
  'authenticated: no UPDATE on issued_at'
);

select is(
  has_column_privilege('authenticated', 'public.invoices', 'voided_at', 'UPDATE'),
  false,
  'authenticated: no UPDATE on voided_at'
);

select is(
  has_column_privilege('authenticated', 'public.invoices', 'void_reason', 'UPDATE'),
  false,
  'authenticated: no UPDATE on void_reason'
);

select is(
  has_column_privilege('authenticated', 'public.invoices', 'business_id', 'UPDATE'),
  false,
  'authenticated: no UPDATE on business_id'
);

select is(
  has_column_privilege('authenticated', 'public.invoices', 'total_amount_paise', 'UPDATE'),
  false,
  'authenticated: no UPDATE on total_amount_paise'
);

select is(
  has_column_privilege('authenticated', 'public.invoices', 'customer_snapshot', 'UPDATE'),
  false,
  'authenticated: no UPDATE on customer_snapshot'
);

select is(
  has_column_privilege('authenticated', 'public.invoices', 'notes', 'UPDATE'),
  false,
  'authenticated: no UPDATE on notes'
);

select is(
  has_column_privilege('authenticated', 'public.invoices', 'due_date', 'UPDATE'),
  false,
  'authenticated: no UPDATE on due_date'
);

-- SECURITY DEFINER RPCs remain executable by authenticated.
select is(
  has_function_privilege('authenticated', 'public.create_invoice(uuid, uuid, date, date, text, text, jsonb, text, text, boolean, numeric)', 'EXECUTE'),
  true,
  'authenticated can execute create_invoice()'
);

select is(
  has_function_privilege('authenticated', 'public.issue_invoice(uuid)', 'EXECUTE'),
  true,
  'authenticated can execute issue_invoice()'
);

select is(
  has_function_privilege('authenticated', 'public.void_invoice(uuid, text)', 'EXECUTE'),
  true,
  'authenticated can execute void_invoice()'
);

select is(
  has_function_privilege('authenticated', 'public.confirm_gst_scheme(uuid, public.gst_scheme)', 'EXECUTE'),
  true,
  'authenticated can execute confirm_gst_scheme()'
);

-- Internal helpers must NOT be executable by clients.
select is(
  has_function_privilege('authenticated', 'public.write_audit_log(uuid, text, uuid, public.audit_action, jsonb, jsonb)', 'EXECUTE'),
  false,
  'authenticated cannot execute write_audit_log()'
);

select is(
  has_function_privilege('authenticated', 'public.assert_can_write(uuid)', 'EXECUTE'),
  false,
  'authenticated cannot execute assert_can_write()'
);

select is(
  has_function_privilege('authenticated', 'public.assert_can_manage(uuid)', 'EXECUTE'),
  false,
  'authenticated cannot execute assert_can_manage()'
);

-- ===========================================================================
-- 7g. Effective privilege audit — public.invoice_items
--
--   Same model as public.invoices: SELECT only for authenticated, nothing for
--   anon or PUBLIC. All writes happen inside create_invoice().
-- ===========================================================================
select is(
  has_table_privilege('authenticated', 'public.invoice_items', 'SELECT'),
  true,
  'invoice_items: authenticated SELECT = true'
);

select is(
  has_table_privilege('authenticated', 'public.invoice_items', 'INSERT'),
  false,
  'invoice_items: authenticated INSERT = false'
);

select is(
  has_table_privilege('authenticated', 'public.invoice_items', 'UPDATE'),
  false,
  'invoice_items: authenticated UPDATE = false'
);

select is(
  has_table_privilege('authenticated', 'public.invoice_items', 'DELETE'),
  false,
  'invoice_items: authenticated DELETE = false'
);

select is(
  has_table_privilege('anon', 'public.invoice_items', 'SELECT'),
  false,
  'invoice_items: anon SELECT = false'
);

select is(
  has_table_privilege('anon', 'public.invoice_items', 'INSERT'),
  false,
  'invoice_items: anon INSERT = false'
);

select is(
  has_table_privilege('anon', 'public.invoice_items', 'UPDATE'),
  false,
  'invoice_items: anon UPDATE = false'
);

select is(
  has_table_privilege('anon', 'public.invoice_items', 'DELETE'),
  false,
  'invoice_items: anon DELETE = false'
);

select is(
  has_table_privilege('public', 'public.invoice_items', 'SELECT'),
  false,
  'invoice_items: PUBLIC SELECT = false'
);

select is(
  has_table_privilege('public', 'public.invoice_items', 'INSERT'),
  false,
  'invoice_items: PUBLIC INSERT = false'
);

select is(
  has_table_privilege('public', 'public.invoice_items', 'UPDATE'),
  false,
  'invoice_items: PUBLIC UPDATE = false'
);

select is(
  has_table_privilege('public', 'public.invoice_items', 'DELETE'),
  false,
  'invoice_items: PUBLIC DELETE = false'
);

-- Direct writes to invoice_items are denied.
select throws_ok(
  $$ insert into public.invoice_items (business_id, invoice_id, line_number, description, quantity, unit_price_paise, gross_amount_paise, taxable_amount_paise, line_total_paise)
     values ('c0000000-0000-0000-0000-00000000000a',
             (select id from public.invoices where invoice_number = 'V2-HISTORIC-001'),
             99, 'Direct insert', 1, 100, 100, 100, 100) $$,
  '42501',
  null,
  'a direct INSERT into public.invoice_items is denied'
);

select throws_ok(
  $$ update public.invoice_items set description = 'tampered'
     where invoice_id = (select id from public.invoices where invoice_number = 'V2-HISTORIC-001') $$,
  '42501',
  null,
  'a direct UPDATE of public.invoice_items is denied'
);

select throws_ok(
  $$ delete from public.invoice_items
     where invoice_id = (select id from public.invoices where invoice_number = 'V2-HISTORIC-001') $$,
  '42501',
  null,
  'a direct DELETE from public.invoice_items is denied'
);

-- The SECURITY DEFINER RPC still creates invoice_items successfully.
select lives_ok(
  $$ select public.create_invoice(
       'c0000000-0000-0000-0000-00000000000a',
       'c0000000-0000-0000-0000-0000000000c1',
       '2026-10-01', '2026-10-31', 'intra_state', '24',
       '[{"description":"RPC line","quantity":"1","unit_price_paise":"10000","tax_rate_basis_points":1800}]'::jsonb,
       null, 'V2-RPC-ITEMS-001'
     ) $$,
  'create_invoice() still writes invoice_items as SECURITY DEFINER'
);

select is(
  (select count(*)::int from public.invoice_items
   where invoice_id = (select id from public.invoices where invoice_number = 'V2-RPC-ITEMS-001')),
  1,
  'the RPC created exactly one invoice item'
);

-- The security_invoker view still reads invoice_items for authenticated.
select is(
  (select count(*)::int from public.invoice_item_discounts
   where invoice_id = (select id from public.invoices where invoice_number = 'V2-RPC-ITEMS-001')),
  1,
  'invoice_item_discounts still reads invoice_items through security_invoker'
);

-- ===========================================================================
-- 8. Historical discount compatibility
--
--   A historical line is one whose discount metadata was never written:
--   discount_type = 'none', discount_value = 0, while
--   discount_percent_basis_points carries the real value.
--
--   The only way to produce such a row through the API is to create it while
--   the invoice is still a DRAFT (the item guard permits draft edits), set the
--   legacy column directly, then issue the invoice. After issue the row is
--   frozen, which is exactly the historical shape.
--
--   The invoice_item_discounts view must then derive the effective discount
--   from discount_percent_basis_points. If the view's fallback CASE were
--   removed, effective_discount_type would be 'none' and
--   effective_discount_value would be 0, so these assertions would fail.
-- ===========================================================================
select lives_ok(
  $$ select public.create_invoice(
       'c0000000-0000-0000-0000-00000000000a',
       'c0000000-0000-0000-0000-0000000000c1',
       '2026-10-01', '2026-10-31', 'intra_state', '24',
       '[{"description":"Historic","quantity":"1","unit_price_paise":"100000","tax_rate_basis_points":1800}]'::jsonb,
       null, 'V2-HISTORIC-001'
     ) $$,
  'a draft invoice is created for the historical-discount test'
);

-- While still a draft, force the legacy shape: metadata unset, legacy column set.
select lives_ok(
  $$ update public.invoice_items
     set discount_type = 'none',
         discount_value = 0,
         discount_percent_basis_points = 1000
     where invoice_id = (select id from public.invoices where invoice_number = 'V2-HISTORIC-001') $$,
  'a draft line can be set to the legacy shape'
);

select lives_ok(
  $$ select public.issue_invoice((select id from public.invoices where invoice_number = 'V2-HISTORIC-001')) $$,
  'the invoice is issued, freezing the legacy-shaped line'
);

select is(
  (select discount_type::text from public.invoice_items
   where invoice_id = (select id from public.invoices where invoice_number = 'V2-HISTORIC-001')),
  'none',
  'the issued line still has discount_type = none (never backfilled)'
);

select is(
  (select discount_value from public.invoice_items
   where invoice_id = (select id from public.invoices where invoice_number = 'V2-HISTORIC-001')),
  0::numeric,
  'the issued line still has discount_value = 0 (never backfilled)'
);

select is(
  (select effective_discount_type::text
   from public.invoice_item_discounts
   where invoice_id = (select id from public.invoices where invoice_number = 'V2-HISTORIC-001')),
  'percent',
  'the view derives percent from the legacy percentage'
);

select is(
  (select effective_discount_value
   from public.invoice_item_discounts
   where invoice_id = (select id from public.invoices where invoice_number = 'V2-HISTORIC-001')),
  1000::numeric,
  'the view derives the legacy basis-point value'
);

select is(
  (select effective_discount_type::text
   from public.invoice_item_discounts
   where invoice_id = (select id from public.invoices where invoice_number = 'V2-EXCL-001')),
  'none',
  'the view reports none for a line with no discount'
);

select is(
  (select effective_discount_value
   from public.invoice_item_discounts
   where invoice_id = (select id from public.invoices where invoice_number = 'V2-EXCL-001')),
  0::numeric,
  'the view reports 0 for a line with no discount'
);

-- ===========================================================================
-- 8b. Cess rate is stored, not reconstructed
--
--   A small taxable value makes reverse reconstruction lossy: 4 paise at 12%
--   cess rounds to 0 paise, from which no rate can be recovered. The rate must
--   therefore be stored on the line.
-- ===========================================================================
select lives_ok(
  $$ select public.create_invoice(
       'c0000000-0000-0000-0000-00000000000a',
       'c0000000-0000-0000-0000-0000000000c1',
       '2026-10-01', '2026-10-31', 'intra_state', '24',
       '[{"description":"Tiny","quantity":"1","unit_price_paise":"4",
          "tax_rate_basis_points":0,"cess_rate_basis_points":1200}]'::jsonb,
       null, 'V2-CESS-TINY'
     ) $$,
  'a tiny cess-bearing line can be created'
);

select is(
  (select cess_rate_basis_points from public.invoice_items
   where invoice_id = (select id from public.invoices where invoice_number = 'V2-CESS-TINY')),
  1200,
  'the cess rate is stored exactly as entered (1200 bp)'
);

select is(
  (select cess_paise from public.invoice_items
   where invoice_id = (select id from public.invoices where invoice_number = 'V2-CESS-TINY')),
  0::numeric,
  'the rounded cess amount is 0 paise, which is why the rate cannot be reconstructed'
);

select is(
  (select total_amount_paise from public.invoices where invoice_number = 'V2-CESS-TINY'),
  4::numeric,
  'the tiny invoice total is 4 paise'
);

-- Cess input validation: rejected before any tax is calculated.
select throws_ok(
  $$ select public.create_invoice(
       'c0000000-0000-0000-0000-00000000000a',
       'c0000000-0000-0000-0000-0000000000c1',
       '2026-10-01', '2026-10-31', 'intra_state', '24',
       '[{"description":"Bad","quantity":"1","unit_price_paise":"1000",
          "tax_rate_basis_points":1800,"cess_rate_basis_points":-100}]'::jsonb,
       null, 'V2-CESS-NEG'
     ) $$,
  '22023',
  null,
  'a negative cess rate is rejected'
);

select throws_ok(
  $$ select public.create_invoice(
       'c0000000-0000-0000-0000-00000000000a',
       'c0000000-0000-0000-0000-0000000000c1',
       '2026-10-01', '2026-10-31', 'intra_state', '24',
       '[{"description":"Bad","quantity":"1","unit_price_paise":"1000",
          "tax_rate_basis_points":1800,"cess_rate_basis_points":10001}]'::jsonb,
       null, 'V2-CESS-HIGH'
     ) $$,
  '22023',
  null,
  'a cess rate above 10000 basis points is rejected'
);

-- ===========================================================================
-- 8c. Exempt supply zeroes every tax component, including cess
-- ===========================================================================
select lives_ok(
  $$ select public.create_invoice(
       'c0000000-0000-0000-0000-00000000000a',
       'c0000000-0000-0000-0000-0000000000c1',
       '2026-10-01', '2026-10-31', 'exempt', '24',
       '[{"description":"Exempt","quantity":"1","unit_price_paise":"100000",
          "tax_rate_basis_points":1800,"cess_rate_basis_points":1200}]'::jsonb,
       null, 'V2-EXEMPT-CESS'
     ) $$,
  'an exempt invoice with a non-zero cess input can be created'
);

select is(
  (select cess_paise from public.invoices where invoice_number = 'V2-EXEMPT-CESS'),
  0::numeric,
  'exempt: cess is zero even though a cess rate was supplied'
);

select is(
  (select cgst_paise + sgst_paise + igst_paise from public.invoices where invoice_number = 'V2-EXEMPT-CESS'),
  0::numeric,
  'exempt: CGST, SGST and IGST are all zero'
);

select is(
  (select total_tax_paise from public.invoices where invoice_number = 'V2-EXEMPT-CESS'),
  0::numeric,
  'exempt: total tax is zero'
);

select is(
  (select total_amount_paise from public.invoices where invoice_number = 'V2-EXEMPT-CESS'),
  100000::numeric,
  'exempt: the total equals the taxable value'
);

-- ===========================================================================
-- 8d. Inclusive invoice-level discount is validated against the inclusive total
--
--   10 x Rs500 inclusive of 18% = Rs5,000 customer-facing, Rs4,237.29 taxable.
--   A Rs4,500 discount is LARGER than the taxable value but SMALLER than the
--   inclusive total, so it must be accepted.
-- ===========================================================================
select lives_ok(
  $$ select public.create_invoice(
       'c0000000-0000-0000-0000-00000000000a',
       'c0000000-0000-0000-0000-0000000000c1',
       '2026-10-01', '2026-10-31', 'intra_state', '24',
       '[{"description":"W","quantity":"10","unit_price_paise":"50000","tax_rate_basis_points":1800}]'::jsonb,
       null, 'V2-INCL-BIGDISC', true, 450000
     ) $$,
  'an inclusive discount larger than the taxable value but smaller than the total is accepted'
);

select is(
  (select invoice_discount_paise from public.invoices where invoice_number = 'V2-INCL-BIGDISC'),
  450000::numeric,
  'the inclusive discount is recorded in full'
);

select is(
  (select total_amount_paise from public.invoices where invoice_number = 'V2-INCL-BIGDISC'),
  50000::numeric,
  'the customer pays the inclusive total minus the discount (Rs500)'
);

select is(
  (select taxable_amount_paise + total_tax_paise from public.invoices where invoice_number = 'V2-INCL-BIGDISC'),
  (select total_amount_paise from public.invoices where invoice_number = 'V2-INCL-BIGDISC'),
  'inclusive discount: taxable + tax reconciles to the total'
);

select throws_ok(
  $$ select public.create_invoice(
       'c0000000-0000-0000-0000-00000000000a',
       'c0000000-0000-0000-0000-0000000000c1',
       '2026-10-01', '2026-10-31', 'intra_state', '24',
       '[{"description":"W","quantity":"10","unit_price_paise":"50000","tax_rate_basis_points":1800}]'::jsonb,
       null, 'V2-INCL-TOOBIG', true, 600000
     ) $$,
  '22023',
  null,
  'an inclusive discount larger than the inclusive total is rejected'
);

-- ===========================================================================
-- 8e. Inclusive discount across lines with different tax rates
-- ===========================================================================
select lives_ok(
  $$ select public.create_invoice(
       'c0000000-0000-0000-0000-00000000000a',
       'c0000000-0000-0000-0000-0000000000c1',
       '2026-10-01', '2026-10-31', 'intra_state', '24',
       '[{"description":"A","quantity":"1","unit_price_paise":"118000","tax_rate_basis_points":1800},
         {"description":"B","quantity":"1","unit_price_paise":"112000","tax_rate_basis_points":1200}]'::jsonb,
       null, 'V2-INCL-MULTI', true, 30000
     ) $$,
  'an inclusive discount across mixed-rate lines is accepted'
);

select is(
  (select total_amount_paise from public.invoices where invoice_number = 'V2-INCL-MULTI'),
  200000::numeric,
  'mixed-rate inclusive: total is the inclusive sum minus the discount'
);

select is(
  (select taxable_amount_paise + total_tax_paise from public.invoices where invoice_number = 'V2-INCL-MULTI'),
  (select total_amount_paise from public.invoices where invoice_number = 'V2-INCL-MULTI'),
  'mixed-rate inclusive: taxable + tax reconciles to the total'
);

select is(
  (select count(*)::int from public.invoice_items
   where invoice_id = (select id from public.invoices where invoice_number = 'V2-INCL-MULTI')
     and line_total_paise < 0),
  0,
  'no line total is negative after the inclusive discount'
);

-- ===========================================================================
-- 8f. Combined item-level and invoice-level discounts
--
--   invoice_items.discount_paise holds the COMBINED discount (item + invoice
--   level). The reconciliation must compare only the invoice-level portion
--   against p_invoice_discount_paise, otherwise it falsely fails whenever an
--   item-level discount is also present.
--
--   Line A: 1 x Rs1,000, fixed Rs100 off, 18% GST
--   Line B: 2 x Rs500,  10% off (Rs100), 18% GST
--   Invoice-level discount: Rs200
--
--   Item-level total = 100 + 100 = 200
--   Taxable before invoice discount = 900 + 900 = 1,800
--   Invoice discount 200 -> taxable 1,600, tax 288, total 1,888
-- ===========================================================================
select lives_ok(
  $$ select public.create_invoice(
       'c0000000-0000-0000-0000-00000000000a',
       'c0000000-0000-0000-0000-0000000000c1',
       '2026-10-01', '2026-10-31', 'intra_state', '24',
       '[{"description":"A","quantity":"1","unit_price_paise":"100000",
          "tax_rate_basis_points":1800,
          "discount_type":"fixed","discount_value":"10000"},
         {"description":"B","quantity":"2","unit_price_paise":"50000",
          "tax_rate_basis_points":1800,
          "discount_type":"percent","discount_value":"1000"}]'::jsonb,
       null, 'V2-COMBINED-001', false, 20000
     ) $$,
  'an invoice with both item-level and invoice-level discounts is accepted'
);

select is(
  (select discount_paise from public.invoices where invoice_number = 'V2-COMBINED-001'),
  20000::numeric,
  'combined: item-level discounts total Rs200'
);

select is(
  (select invoice_discount_paise from public.invoices where invoice_number = 'V2-COMBINED-001'),
  20000::numeric,
  'combined: invoice-level discount is Rs200'
);

select is(
  (select taxable_amount_paise from public.invoices where invoice_number = 'V2-COMBINED-001'),
  160000::numeric,
  'combined: taxable value is Rs1,600'
);

select is(
  (select total_tax_paise from public.invoices where invoice_number = 'V2-COMBINED-001'),
  28800::numeric,
  'combined: tax is Rs288 (18% of Rs1,600)'
);

select is(
  (select total_amount_paise from public.invoices where invoice_number = 'V2-COMBINED-001'),
  188800::numeric,
  'combined: total is Rs1,888'
);

select is(
  (select sum(discount_paise) from public.invoice_items
   where invoice_id = (select id from public.invoices where invoice_number = 'V2-COMBINED-001')),
  40000::numeric,
  'combined: line discount_paise holds item + invoice level (Rs400)'
);

-- Issued line items must remain immutable.
select throws_ok(
  $$ update public.invoice_items set discount_type = 'fixed'
     where invoice_id = (select id from public.invoices where invoice_number = 'V2-EXCL-001') $$,
  '22023',
  null,
  'discount_type cannot change on an issued invoice line'
);

select throws_ok(
  $$ update public.invoice_items set discount_value = 500
     where invoice_id = (select id from public.invoices where invoice_number = 'V2-EXCL-001') $$,
  '22023',
  null,
  'discount_value cannot change on an issued invoice line'
);

select throws_ok(
  $$ update public.invoice_items set cess_rate_basis_points = 1200
     where invoice_id = (select id from public.invoices where invoice_number = 'V2-EXCL-001') $$,
  '22023',
  null,
  'cess_rate_basis_points cannot change on an issued invoice line'
);

-- ===========================================================================
-- 9. GST scheme confirmation authorization
-- ===========================================================================
select lives_ok(
  $$ select public.confirm_gst_scheme('c0000000-0000-0000-0000-00000000000a', 'regular') $$,
  'an owner can confirm the GST scheme for their own business'
);

select is(
  (select gst_scheme_needs_review from public.businesses where id = 'c0000000-0000-0000-0000-00000000000a'),
  false,
  'confirming clears the review flag'
);

-- A read-only member must not be able to change the scheme.
set local request.jwt.claims = '{"sub":"c2222222-2222-2222-2222-222222222222","role":"authenticated"}';

select throws_ok(
  $$ select public.confirm_gst_scheme('c0000000-0000-0000-0000-00000000000a', 'composition') $$,
  '42501',
  null,
  'a read-only member cannot confirm the GST scheme'
);

-- A member of another business must not be able to change this business.
set local request.jwt.claims = '{"sub":"c3333333-3333-3333-3333-333333333333","role":"authenticated"}';

select throws_ok(
  $$ select public.confirm_gst_scheme('c0000000-0000-0000-0000-00000000000a', 'composition') $$,
  '42501',
  null,
  'a user from another business cannot confirm this business GST scheme'
);

-- Restore the original owner's identity before reading business A's scheme.
-- Without this the next assertion would run as the other tenant, RLS would
-- hide the row, and the subquery would return NULL instead of 'regular'.
set local request.jwt.claims = '{"sub":"c1111111-1111-1111-1111-111111111111","role":"authenticated"}';

select is(
  (select gst_scheme::text from public.businesses where id = 'c0000000-0000-0000-0000-00000000000a'),
  'regular',
  'the scheme is unchanged after the rejected attempts'
);

select is(
  (select gst_scheme_needs_review from public.businesses where id = 'c0000000-0000-0000-0000-00000000000a'),
  false,
  'the review flag is still cleared after the rejected attempts'
);

reset role;

select * from finish();
rollback;
