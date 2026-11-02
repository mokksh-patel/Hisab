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

select plan(37);

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
       (''c1111111-1111-1111-1111-111111111111''::uuid, ''v2-owner@example.test'')
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
  ('c0000000-0000-0000-0000-00000000000d', 'c1111111-1111-1111-1111-111111111111', 'owner', 'accepted');

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

-- A composition supply is taxable at a flat rate, NOT exempt. Until Bill of
-- Supply exists, a composition business must not be able to record the supply
-- at all — recording it as exempt would misstate the tax position.
select throws_ok(
  $$ select public.create_invoice(
       'c0000000-0000-0000-0000-00000000000b',
       'c0000000-0000-0000-0000-0000000000c2',
       '2026-10-01', '2026-10-31', 'exempt', '24',
       '[{"description":"Widget","quantity":"1","unit_price_paise":"1000","tax_rate_basis_points":0}]'::jsonb,
       null, 'V2-COMP-EXEMPT'
     ) $$,
  '22023',
  null,
  'a composition business cannot record a supply as exempt either'
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

reset role;

select * from finish();
rollback;
