-- ===========================================================================
-- BizPilot — 0005 invoice engine v2
--
-- ADDITIVE ONLY. Nothing here changes the meaning of existing data.
--
-- TRANSACTIONALITY — DO NOT ADD BEGIN/COMMIT TO THIS FILE
--   The Supabase CLI decides how to run a migration by inspecting its FIRST
--   LINE. If the first line is exactly `-- pg-delta: transaction=false` the
--   file runs in transactionMode "none" (statement by statement). Otherwise it
--   runs in transactionMode "transactional" and the CLI wraps the whole file in
--   a single transaction.
--
--   This file's first line is a comment banner, so it resolves to
--   "transactional" and the CLI provides the transaction.
--
--   Adding an explicit BEGIN/COMMIT here would be actively harmful: the inner
--   COMMIT commits the CLI's outer transaction early, so a later failure leaves
--   partial DDL behind. That is exactly what happened on the first attempt.
--   Verified empirically — see scripts/test-nested-begin.mjs.
--
--   The CLI also records the migration in supabase_migrations.schema_migrations
--   inside the same transaction, so history and DDL commit together.
--
-- WHAT THIS MIGRATION ADDS
--   1. businesses.gst_scheme        — unregistered | regular | composition
--   2. invoices.price_includes_tax  — whether line prices were tax-inclusive
--   3. invoices.invoice_discount_paise — invoice-level discount (distinct from
--      the existing invoices.discount_paise, which is the SUM of item discounts)
--   4. invoice_items.discount_type  — none | percent | fixed
--   5. invoice_items.discount_value — the raw discount input (bp or paise)
--   6. create_invoice() v2          — inclusive pricing, fixed discounts,
--                                     invoice-level discount, GST scheme checks
--   7. confirm_gst_scheme()         — owner-only scheme confirmation
--   8. invoice_item_discounts view  — read-time fallback for issued lines
--
-- BACKWARDS COMPATIBILITY
--   * Every new column is nullable or has a default that reproduces the old
--     behaviour exactly.
--   * Existing invoices keep price_includes_tax = false and
--     invoice_discount_paise = 0, so their stored totals remain correct.
--   * Existing ISSUED invoice_items are never modified. Their discount metadata
--     is derived at read time from discount_percent_basis_points via the
--     invoice_item_discounts view. Only DRAFT items are backfilled.
--   * Existing businesses get gst_scheme = 'unregistered' ONLY when they are
--     not GST-registered. Registered businesses are set to 'regular' but flagged
--     for review via a dedicated column, because we must not silently assume a
--     composition taxpayer is regular.
--   * create_invoice() keeps its original signature and gains two optional
--     trailing parameters, so existing callers continue to work unchanged.
--
-- RESTARTABILITY
--   Every DDL statement is guarded: enums use IF NOT EXISTS, columns use
--   ADD COLUMN IF NOT EXISTS, constraints use DROP CONSTRAINT IF EXISTS before
--   ADD, and functions/views use CREATE OR REPLACE. The migration can be
--   re-run against a partially-applied database without duplicating objects.
--
-- ROLLBACK
--   See the DOWN section at the bottom of this file. It is commented out so the
--   migration is forward-only by default; run it manually if a rollback is
--   required before any data depends on the new columns.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. GST scheme on businesses
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'gst_scheme'
  ) then
    create type public.gst_scheme as enum ('unregistered', 'regular', 'composition');
  end if;
end;
$$;

alter table public.businesses
  add column if not exists gst_scheme public.gst_scheme;

-- Backfill. This is deliberately conservative:
--   * not GST-registered  -> 'unregistered' (certain)
--   * GST-registered      -> 'regular' (the common case) BUT flagged for review
--     because a composition taxpayer must not issue tax invoices.
--
-- RESTARTABILITY: this migration may be retried against a partially applied
-- database. The backfill must therefore be idempotent AND must not re-flag a
-- business whose owner has already confirmed its scheme.
--
-- The two statements below are safe because:
--   1. The scheme backfill only touches rows where gst_scheme IS NULL, so a
--      business that already has a scheme (inferred or confirmed) is untouched.
--   2. The review flag is only set on rows that were JUST inferred by this
--      migration — i.e. rows whose scheme was NULL before this statement ran.
--      A business that confirmed its scheme has needs_review = false and a
--      non-null scheme, so it is never re-flagged.
--
-- To make (2) explicit and independent of statement ordering, the inference is
-- done in a single statement that records which rows it touched.
alter table public.businesses
  add column if not exists gst_scheme_needs_review boolean not null default false;

do $$
declare
  v_inferred uuid[];
begin
  -- Capture the ids that are about to be inferred, so the review flag is
  -- applied only to those rows and never to a previously confirmed business.
  select coalesce(array_agg(id), '{}')
    into v_inferred
  from public.businesses
  where gst_scheme is null;

  if array_length(v_inferred, 1) is null then
    raise notice 'gst_scheme backfill: nothing to infer';
    return;
  end if;

  update public.businesses
  set gst_scheme = case
        when is_gst_registered then 'regular'::public.gst_scheme
        else 'unregistered'::public.gst_scheme
      end,
      -- Flag only registered businesses, and only the ones inferred here.
      gst_scheme_needs_review = is_gst_registered
  where id = any (v_inferred);

  raise notice 'gst_scheme backfill: % business(es) inferred', array_length(v_inferred, 1);
end;
$$;

alter table public.businesses
  alter column gst_scheme set default 'unregistered';

-- A composition-scheme taxpayer IS GST-registered, but may not collect GST from
-- customers or issue a tax invoice. The registration flag and the scheme must
-- therefore agree:
--   unregistered -> is_gst_registered = false
--   regular      -> is_gst_registered = true
--   composition  -> is_gst_registered = true
alter table public.businesses
  drop constraint if exists businesses_composition_not_registered;
alter table public.businesses
  drop constraint if exists businesses_gst_scheme_registration_consistent;
alter table public.businesses
  add constraint businesses_gst_scheme_registration_consistent
  check (
    (gst_scheme = 'unregistered' and is_gst_registered = false)
    or (gst_scheme = 'regular' and is_gst_registered = true)
    or (gst_scheme = 'composition' and is_gst_registered = true)
  );

comment on column public.businesses.gst_scheme is
  'GST registration category. unregistered = no GST; regular = may issue tax invoices; composition = may NOT issue tax invoices.';
comment on column public.businesses.gst_scheme_needs_review is
  'True when the scheme was inferred during migration and an owner must confirm it.';

-- ---------------------------------------------------------------------------
-- 1b. create_business_with_owner() — explicit GST scheme selection
--
--   The consistency constraint above means a business cannot be inserted with
--   is_gst_registered = true while gst_scheme keeps its 'unregistered' default.
--   The 0003 version of this function inserts is_gst_registered but not
--   gst_scheme, so every GST-registered signup would fail the constraint.
--
--   IMPORTANT: this function does NOT assume that a GST-registered business
--   follows the regular scheme. A composition taxpayer is also GST-registered
--   but may not collect GST or issue a tax invoice. Assuming 'regular' would
--   let a composition business issue an invalid tax invoice.
--
--   The caller must therefore state the scheme explicitly:
--
--     p_gst_scheme = 'unregistered'  -> is_gst_registered forced to false
--     p_gst_scheme = 'regular'       -> is_gst_registered forced to true,
--                                       needs_review = false (explicit choice)
--     p_gst_scheme = 'composition'   -> is_gst_registered forced to true,
--                                       needs_review = false (explicit choice)
--     p_gst_scheme = NULL            -> derived from p_is_gst_registered:
--                                         false -> 'unregistered', no review
--                                         true  -> 'regular' BUT
--                                                  needs_review = true, so the
--                                                  owner must confirm before any
--                                                  tax invoice can be issued
--
--   The NULL branch is the backwards-compatible path for existing callers that
--   only pass p_is_gst_registered. It never silently enables tax invoicing: a
--   registered business created that way is flagged for review and blocked by
--   the create_invoice() guard until confirmed.
-- ---------------------------------------------------------------------------
create or replace function public.create_business_with_owner(
  p_legal_name text,
  p_display_name text,
  p_business_type text default null,
  p_gstin text default null,
  p_city text default null,
  p_state_code text default null,
  p_phone text default null,
  p_email text default null,
  p_is_gst_registered boolean default false,
  p_invoice_prefix text default 'INV',
  p_default_credit_period_days smallint default 30,
  p_gst_scheme public.gst_scheme default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_business_id uuid;
  v_scheme public.gst_scheme;
  v_registered boolean;
  v_needs_review boolean;
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if coalesce(trim(p_legal_name), '') = '' then
    raise exception 'Legal name is required' using errcode = '22023';
  end if;
  if coalesce(trim(p_display_name), '') = '' then
    raise exception 'Display name is required' using errcode = '22023';
  end if;

  if p_gst_scheme is not null then
    -- Explicit choice: the scheme determines the registration flag.
    v_scheme := p_gst_scheme;
    v_registered := (p_gst_scheme <> 'unregistered');
    v_needs_review := false;
  else
    -- Legacy path: only the registration flag was supplied.
    if coalesce(p_is_gst_registered, false) then
      -- We do NOT know whether this is regular or composition. Record the
      -- common case but flag it so the owner must confirm before invoicing.
      v_scheme := 'regular';
      v_registered := true;
      v_needs_review := true;
    else
      v_scheme := 'unregistered';
      v_registered := false;
      v_needs_review := false;
    end if;
  end if;

  insert into public.businesses (
    legal_name, display_name, business_type, gstin, city, state_code, phone, email,
    is_gst_registered, gst_scheme, gst_scheme_needs_review,
    invoice_prefix, default_credit_period_days
  )
  values (
    trim(p_legal_name), trim(p_display_name), p_business_type, p_gstin, p_city, p_state_code,
    p_phone, p_email,
    v_registered, v_scheme, v_needs_review,
    coalesce(p_invoice_prefix, 'INV'),
    coalesce(p_default_credit_period_days, 30)
  )
  returning id into v_business_id;

  insert into public.business_members (business_id, user_id, role, invitation_status)
  values (v_business_id, v_user_id, 'owner', 'accepted');

  perform public.write_audit_log(
    v_business_id, 'business', v_business_id, 'business.created', null,
    jsonb_build_object(
      'legal_name', p_legal_name,
      'display_name', p_display_name,
      'gst_scheme', v_scheme,
      'gst_scheme_needs_review', v_needs_review
    )
  );

  return v_business_id;
end;
$$;

revoke all on function public.create_business_with_owner(text, text, text, text, text, text, text, text, boolean, text, smallint, public.gst_scheme) from public;
grant execute on function public.create_business_with_owner(text, text, text, text, text, text, text, text, boolean, text, smallint, public.gst_scheme) to authenticated;

-- ---------------------------------------------------------------------------
-- 1c. Drop the redundant 11-argument wrapper
--
--   WHY: PostgreSQL resolves a call by the number of arguments supplied. With
--   both an 11-argument function and a 12-argument function whose 12th
--   parameter has a DEFAULT, a call with 11 arguments matches BOTH candidates
--   and PostgreSQL raises:
--       ERROR: function public.create_business_with_owner(...) is not unique
--
--   The 12-argument function already accepts 11 arguments because
--   p_gst_scheme defaults to NULL, and that NULL path reproduces the old
--   behaviour exactly (registered -> 'regular' + needs_review = true). The
--   wrapper therefore adds nothing but ambiguity.
--
--   Existing callers are unaffected: they pass 11 arguments and now resolve
--   unambiguously to the 12-argument function.
-- ---------------------------------------------------------------------------
drop function if exists public.create_business_with_owner(
  text, text, text, text, text, text, text, text, boolean, text, smallint
);

-- ---------------------------------------------------------------------------
-- 2. Invoice-level pricing mode and discount
-- ---------------------------------------------------------------------------
alter table public.invoices
  add column if not exists price_includes_tax boolean not null default false;

alter table public.invoices
  add column if not exists invoice_discount_paise numeric(20,0) not null default 0;

alter table public.invoices
  drop constraint if exists invoices_invoice_discount_non_negative;
alter table public.invoices
  add constraint invoices_invoice_discount_non_negative
  check (invoice_discount_paise >= 0);

comment on column public.invoices.price_includes_tax is
  'True when line unit prices were entered tax-inclusive. Existing invoices are false.';
comment on column public.invoices.invoice_discount_paise is
  'Invoice-level discount. invoices.discount_paise remains the SUM of item-level discounts.';

-- ---------------------------------------------------------------------------
-- 3. Item-level discount type and raw value
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'discount_type'
  ) then
    create type public.discount_type as enum ('none', 'percent', 'fixed');
  end if;
end;
$$;

alter table public.invoice_items
  add column if not exists discount_type public.discount_type not null default 'none';

alter table public.invoice_items
  add column if not exists discount_value numeric(20,0) not null default 0;

-- ---------------------------------------------------------------------------
-- 3b. Store the cess RATE, not just the cess amount
--
--   WHY: `create_invoice()` accepts `cess_rate_basis_points` per line but the
--   table only stored `cess_paise`. Recomputing the rate from the amount is
--   lossy: on a small taxable value the rounded cess_paise can imply a
--   different rate than the one entered.
--
--   Example: taxable 100 paise at 12% cess = 12 paise exactly, but taxable
--   4 paise at 12% cess = round(0.48) = 0 paise, from which the rate cannot be
--   recovered at all. Storing the rate removes the guesswork.
--
--   Existing rows get 0. That is correct for every historical line because the
--   UI has always sent cess_rate_basis_points = 0, so no historical line ever
--   carried cess. Any line that did carry cess would have a non-zero
--   cess_paise; the backfill below derives the rate for those rows only, and
--   only where the derivation is exact.
-- ---------------------------------------------------------------------------
alter table public.invoice_items
  add column if not exists cess_rate_basis_points integer not null default 0;

alter table public.invoice_items
  drop constraint if exists invoice_items_cess_rate_range;
alter table public.invoice_items
  add constraint invoice_items_cess_rate_range
  check (cess_rate_basis_points between 0 and 10000);

comment on column public.invoice_items.cess_rate_basis_points is
  'Compensation cess rate in basis points, as entered. Stored so the rate is never reconstructed from a rounded amount.';

-- Backfill the rate for DRAFT lines only.
--
-- Issued invoice items are immutable: `invoice_items_guard_change` rejects any
-- update to a line whose parent invoice is not a draft. This migration must
-- never attempt to write to them, so the backfill is scoped to drafts.
--
-- In practice this is a no-op: the UI has always sent
-- cess_rate_basis_points = 0, so no historical line carries cess. The statement
-- exists so that a draft line created by an older client, which did carry cess,
-- gets its rate recorded rather than left at 0.
--
-- An unknown historical rate is NEVER inferred from a rounded cess amount.
update public.invoice_items ii
set cess_rate_basis_points = round(ii.cess_paise * 10000 / ii.taxable_amount_paise)
from public.invoices i
where i.id = ii.invoice_id
  and i.document_state = 'draft'
  and ii.cess_paise > 0
  and ii.taxable_amount_paise > 0
  and ii.cess_rate_basis_points = 0
  and round(ii.cess_paise * 10000 / ii.taxable_amount_paise)::numeric
      = (ii.cess_paise * 10000 / ii.taxable_amount_paise);

-- Backfill: existing items used percentage discounts only.
--
-- WHY THIS DOES NOT TOUCH ISSUED INVOICES
-- `invoice_items_guard_change` rejects ANY update to a line item whose parent
-- invoice is not a draft. Every historical line item belongs to an issued
-- invoice, so a plain UPDATE fails with:
--     'Line items of an issued invoice cannot be changed' (SQLSTATE 22023)
--
-- Rather than disable that guard — even briefly — the backfill is split:
--
--   1. DRAFT items are updated directly. The guard permits this by design.
--   2. ISSUED items are left untouched. Their discount metadata is derived at
--      read time from `discount_percent_basis_points`, which is the field they
--      have always carried. A view (`invoice_item_discounts`) exposes the
--      derived values so no application code needs a COALESCE.
--
-- This keeps issued invoices byte-for-byte immutable, which is the whole point
-- of the guard. The cost is one extra view; the benefit is that no migration
-- ever weakens a financial control.
--
-- WHY NOT A TRIGGER BYPASS
-- A bypass would work, but it means the migration temporarily disables the
-- exact protection that stops financial history being rewritten. If the
-- migration crashed between disable and enable, the table would be left
-- unprotected. The fallback has no such window.

-- 1. Draft items: safe to update, the guard allows it.
update public.invoice_items ii
set discount_type = case
      when ii.discount_percent_basis_points > 0 then 'percent'::public.discount_type
      else 'none'::public.discount_type
    end,
    discount_value = ii.discount_percent_basis_points
from public.invoices i
where i.id = ii.invoice_id
  and i.document_state = 'draft'
  and ii.discount_type = 'none'
  and ii.discount_value = 0;

-- 2. Issued items: deliberately NOT updated. Record how many rely on the
--    fallback so the number is visible in the migration log.
do $$
declare
  v_issued integer;
begin
  select count(*) into v_issued
  from public.invoice_items ii
  join public.invoices i on i.id = ii.invoice_id
  where i.document_state <> 'draft'
    and ii.discount_type = 'none'
    and ii.discount_value = 0
    and ii.discount_percent_basis_points > 0;

  if v_issued > 0 then
    raise notice
      'invoice_items: % issued line(s) keep discount metadata in discount_percent_basis_points and are read through invoice_item_discounts',
      v_issued;
  end if;
end;
$$;

-- 3. A view that presents the effective discount for every line, whether the
--    metadata was written (draft) or derived (issued). Application code reads
--    this instead of the raw columns.
create or replace view public.invoice_item_discounts
with (security_invoker = true)
as
select
  ii.id as invoice_item_id,
  ii.business_id,
  ii.invoice_id,
  ii.discount_percent_basis_points,
  ii.discount_paise,
  -- Effective type: the stored value when it was written, otherwise derived
  -- from the legacy percentage field.
  case
    when ii.discount_type <> 'none' then ii.discount_type
    when ii.discount_percent_basis_points > 0 then 'percent'::public.discount_type
    else 'none'::public.discount_type
  end as effective_discount_type,
  -- Effective raw value: basis points for percent, paise for fixed.
  case
    when ii.discount_type <> 'none' then ii.discount_value
    when ii.discount_percent_basis_points > 0 then ii.discount_percent_basis_points::numeric(20,0)
    else 0::numeric(20,0)
  end as effective_discount_value
from public.invoice_items ii;

comment on view public.invoice_item_discounts is
  'Effective discount metadata for every invoice line. Issued lines derive it from discount_percent_basis_points because they are immutable.';

grant select on public.invoice_item_discounts to authenticated;

-- Safety assertion: the immutability guard must be enabled. This migration
-- never disables it, so a failure here means something else changed it.
do $$
declare
  v_enabled "char";
begin
  select tgenabled into v_enabled
  from pg_trigger
  where tgname = 'invoice_items_guard_change'
    and tgrelid = 'public.invoice_items'::regclass;

  if v_enabled is null or v_enabled = 'D' then
    raise exception
      'invoice_items_guard_change is not enabled — aborting migration'
      using errcode = '22023';
  end if;
end;
$$;

comment on column public.invoice_items.discount_type is
  'How the discount was entered. percent -> discount_value is basis points; fixed -> discount_value is paise.';
comment on column public.invoice_items.discount_value is
  'Raw discount input. Basis points for percent, paise for fixed.';

-- ---------------------------------------------------------------------------
-- 4. create_invoice() v2
--
--    Signature is extended with two OPTIONAL trailing parameters so existing
--    callers keep working:
--      p_price_includes_tax   default false
--      p_invoice_discount_paise default 0
--
--    Line objects gain two OPTIONAL keys:
--      discount_type   'none' | 'percent' | 'fixed'  (default 'percent')
--      discount_value  basis points or paise         (default 0)
--
--    The old keys (discount_percent_basis_points) are still honoured.
-- ---------------------------------------------------------------------------
create or replace function public.create_invoice(
  p_business_id uuid,
  p_customer_id uuid,
  p_invoice_date date,
  p_due_date date,
  p_gst_mode text,
  p_place_of_supply_state_code text,
  p_lines jsonb,
  p_notes text default null,
  p_invoice_number text default null,
  p_price_includes_tax boolean default false,
  p_invoice_discount_paise numeric default 0
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_invoice_id uuid;
  v_customer public.customers%rowtype;
  v_business public.businesses%rowtype;
  v_financial_year text;
  v_number text;
  v_line jsonb;
  v_line_no integer := 0;
  v_qty numeric(14,3);
  v_price numeric(20,0);
  v_disc_type public.discount_type;
  v_disc_value numeric(20,0);
  v_disc_bp integer;
  v_tax_bp integer;
  v_cess_bp integer;
  v_gross numeric(20,0);
  v_discount numeric(20,0);
  v_net numeric(20,0);
  v_taxable numeric(20,0);
  v_cgst numeric(20,0);
  v_sgst numeric(20,0);
  v_igst numeric(20,0);
  v_cess numeric(20,0);
  v_line_total numeric(20,0);
  v_total_rate_bp integer;
  v_total_tax numeric(20,0);
  v_gst_portion numeric(20,0);
  v_subtotal numeric(20,0) := 0;
  v_item_discount_total numeric(20,0) := 0;
  v_taxable_total numeric(20,0) := 0;
  v_cgst_total numeric(20,0) := 0;
  v_sgst_total numeric(20,0) := 0;
  v_igst_total numeric(20,0) := 0;
  v_cess_total numeric(20,0) := 0;
  v_total numeric(20,0);
  v_invoice_discount numeric(20,0) := coalesce(p_invoice_discount_paise, 0);
begin
  perform public.assert_can_write(p_business_id);

  if p_gst_mode not in ('intra_state', 'inter_state', 'exempt') then
    raise exception 'Invalid GST mode "%"', p_gst_mode using errcode = '22023';
  end if;
  if p_due_date < p_invoice_date then
    raise exception 'Due date cannot be before the invoice date' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'An invoice needs at least one line item' using errcode = '22023';
  end if;
  if v_invoice_discount < 0 then
    raise exception 'Invoice discount cannot be negative' using errcode = '22023';
  end if;

  -- GST scheme guard.
  --
  --   A composition-scheme business may not issue a TAX invoice or collect GST
  --   from customers. It MAY still record a genuinely exempt supply, because
  --   exemption is a property of the goods or services, not of the business's
  --   registration scheme. Blocking exempt supplies for composition taxpayers
  --   would be wrong.
  --
  --   What a composition business must NOT do is record its own composition
  --   turnover as "exempt" — that turnover is taxable at a flat rate under the
  --   composition scheme, and BizPilot has no Bill of Supply document to record
  --   it correctly. That distinction is a business-process rule, not something
  --   the database can infer from p_gst_mode alone, so it is surfaced in the UI
  --   and documented here rather than enforced by rejecting exempt invoices.
  select * into v_business from public.businesses where id = p_business_id;
  if not found then
    raise exception 'Business not found' using errcode = 'P0002';
  end if;

  if p_gst_mode <> 'exempt' then
    -- An unconfirmed scheme must be resolved before any GST is charged. This is
    -- enforced server-side because a UI banner can be bypassed by calling the
    -- RPC directly.
    if coalesce(v_business.gst_scheme_needs_review, false) then
      raise exception
        'Your GST scheme has not been confirmed. Open Settings and confirm whether you are registered under the regular or composition scheme before issuing a tax invoice.'
        using errcode = '22023';
    end if;

    if v_business.gst_scheme = 'composition' then
      raise exception
        'A composition-scheme business cannot issue a tax invoice or collect GST from customers. Bill of Supply is not yet supported in BizPilot. If this supply is genuinely exempt, record it with GST treatment set to Exempt.'
        using errcode = '22023';
    end if;
    if v_business.gst_scheme = 'unregistered' then
      raise exception
        'An unregistered business cannot charge GST. Use exempt supply for this invoice.'
        using errcode = '22023';
    end if;
    if v_business.gst_scheme is null then
      raise exception
        'This business has no GST scheme set. Confirm it in Settings before issuing a tax invoice.'
        using errcode = '22023';
    end if;
  end if;

  -- The customer must belong to the same business (cross-tenant guard).
  select * into v_customer
  from public.customers
  where id = p_customer_id and business_id = p_business_id;
  if not found then
    raise exception 'Customer not found in this business' using errcode = 'P0002';
  end if;

  v_financial_year := public.financial_year_of(p_invoice_date);

  if p_invoice_number is null or trim(p_invoice_number) = '' then
    v_number := public.next_invoice_number(p_business_id, v_financial_year);
  else
    v_number := trim(p_invoice_number);
  end if;

  insert into public.invoices (
    business_id, customer_id, invoice_number, financial_year, invoice_date, due_date,
    document_state, place_of_supply_state_code, gst_mode, notes, created_by,
    price_includes_tax
  )
  values (
    p_business_id, p_customer_id, v_number, v_financial_year, p_invoice_date, p_due_date,
    'draft', p_place_of_supply_state_code, p_gst_mode, p_notes, v_user_id,
    coalesce(p_price_includes_tax, false)
  )
  returning id into v_invoice_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_line_no := v_line_no + 1;

    v_qty := (v_line ->> 'quantity')::numeric(14,3);
    v_price := (v_line ->> 'unit_price_paise')::numeric(20,0);
    v_tax_bp := coalesce((v_line ->> 'tax_rate_basis_points')::integer, 0);
    v_cess_bp := coalesce((v_line ->> 'cess_rate_basis_points')::integer, 0);

    -- Discount: new keys take precedence, old key still honoured.
    if v_line ? 'discount_type' then
      v_disc_type := (v_line ->> 'discount_type')::public.discount_type;
      v_disc_value := coalesce((v_line ->> 'discount_value')::numeric(20,0), 0);
    else
      v_disc_bp := coalesce((v_line ->> 'discount_percent_basis_points')::integer, 0);
      v_disc_type := case when v_disc_bp > 0 then 'percent'::public.discount_type
                          else 'none'::public.discount_type end;
      v_disc_value := v_disc_bp;
    end if;

    if v_qty is null or v_qty <= 0 then
      raise exception 'Line % has an invalid quantity', v_line_no using errcode = '22023';
    end if;
    if v_price is null or v_price < 0 then
      raise exception 'Line % has an invalid unit price', v_line_no using errcode = '22023';
    end if;
    if v_tax_bp < 0 or v_tax_bp > 10000 then
      raise exception 'Line % has an invalid tax rate', v_line_no using errcode = '22023';
    end if;
    -- Cess is validated before any tax is calculated, with the same SQLSTATE
    -- and message shape as the other per-line input checks.
    if v_cess_bp is null or v_cess_bp < 0 or v_cess_bp > 10000 then
      raise exception 'Line % has an invalid cess rate', v_line_no using errcode = '22023';
    end if;
    if v_disc_value < 0 then
      raise exception 'Line % has a negative discount', v_line_no using errcode = '22023';
    end if;
    if v_disc_type = 'percent' and v_disc_value > 10000 then
      raise exception 'Line % discount cannot exceed 100 percent', v_line_no using errcode = '22023';
    end if;

    -- Integer paise arithmetic with half-up rounding, mirroring money.ts.
    --
    -- PARITY NOTE: every division below uses integer operands so PostgreSQL
    -- performs exact numeric division, never floating point. `round()` on a
    -- numeric is half-up, matching `multiplyPaise()` in src/lib/money.ts.
    -- Do not introduce `::float` or `/ 10000.0` here — that would drift from
    -- the client by a paise on some inputs.
    v_gross := round(v_price * v_qty);

    if v_disc_type = 'percent' then
      v_discount := round(v_gross * v_disc_value / 10000);
    elsif v_disc_type = 'fixed' then
      v_discount := v_disc_value;
      if v_discount > v_gross then
        raise exception 'Line % discount cannot exceed the line amount', v_line_no
          using errcode = '22023';
      end if;
    else
      v_discount := 0;
    end if;

    v_net := v_gross - v_discount;
    v_total_rate_bp := v_tax_bp + v_cess_bp;

    if coalesce(p_price_includes_tax, false) then
      -- Back-solve the taxable value from the tax-inclusive net amount.
      if v_total_rate_bp = 0 or p_gst_mode = 'exempt' then
        v_taxable := v_net;
        v_cgst := 0; v_sgst := 0; v_igst := 0; v_cess := 0;
      else
        v_taxable := round(v_net * 10000 / (10000 + v_total_rate_bp));
        v_total_tax := v_net - v_taxable;

        if p_gst_mode = 'inter_state' then
          v_cess := round(v_total_tax * v_cess_bp / v_total_rate_bp);
          v_igst := v_total_tax - v_cess;
          v_cgst := 0; v_sgst := 0;
        else
          v_gst_portion := round(v_total_tax * v_tax_bp / v_total_rate_bp);
          v_cess := v_total_tax - v_gst_portion;
          -- Cess-only line (tax rate 0, cess > 0): there is no GST to split,
          -- so CGST/SGST stay zero. Guarding here avoids a division by zero.
          if v_tax_bp = 0 then
            v_cgst := 0;
            v_sgst := 0;
          else
            v_cgst := round(v_gst_portion * floor(v_tax_bp / 2.0) / v_tax_bp);
            v_sgst := v_gst_portion - v_cgst;
          end if;
          v_igst := 0;
        end if;
      end if;
    else
      v_taxable := v_net;

      if p_gst_mode = 'exempt' then
        -- Exempt supply: no tax of any kind, including cess. The whole net is
        -- taxable value. This must match calculateLine() in
        -- src/lib/invoiceCalculations.ts.
        v_cgst := 0;
        v_sgst := 0;
        v_igst := 0;
        v_cess := 0;
      else
        if p_gst_mode = 'inter_state' then
          v_igst := round(v_taxable * v_tax_bp / 10000);
          v_cgst := 0;
          v_sgst := 0;
        elsif p_gst_mode = 'intra_state' then
          v_cgst := round(v_taxable * floor(v_tax_bp / 2.0) / 10000);
          v_sgst := round(v_taxable * (v_tax_bp - floor(v_tax_bp / 2.0)) / 10000);
          v_igst := 0;
        else
          v_cgst := 0;
          v_sgst := 0;
          v_igst := 0;
        end if;

        v_cess := round(v_taxable * v_cess_bp / 10000);
      end if;
    end if;

    v_line_total := v_taxable + v_cgst + v_sgst + v_igst + v_cess;

    insert into public.invoice_items (
      business_id, invoice_id, line_number, description, hsn_sac, quantity, unit,
      unit_price_paise, discount_percent_basis_points, discount_type, discount_value,
      gross_amount_paise, discount_paise,
      taxable_amount_paise, tax_rate_basis_points, cgst_paise, sgst_paise, igst_paise,
      cess_rate_basis_points, cess_paise, line_total_paise
    )
    values (
      p_business_id, v_invoice_id, v_line_no, trim(v_line ->> 'description'),
      nullif(trim(coalesce(v_line ->> 'hsn_sac', '')), ''), v_qty,
      nullif(trim(coalesce(v_line ->> 'unit', '')), ''),
      v_price,
      case when v_disc_type = 'percent' then v_disc_value::integer else 0 end,
      v_disc_type, v_disc_value,
      v_gross, v_discount, v_taxable, v_tax_bp,
      v_cgst, v_sgst, v_igst, v_cess_bp, v_cess, v_line_total
    );

    v_subtotal := v_subtotal + v_gross;
    v_item_discount_total := v_item_discount_total + v_discount;
    v_taxable_total := v_taxable_total + v_taxable;
    v_cgst_total := v_cgst_total + v_cgst;
    v_sgst_total := v_sgst_total + v_sgst;
    v_igst_total := v_igst_total + v_igst;
    v_cess_total := v_cess_total + v_cess;
  end loop;

  -- Invoice-level discount.
  --
  -- PARITY NOTE: this must match `allocateInvoiceDiscount()` in
  -- src/lib/invoiceCalculations.ts exactly. The discount is allocated across
  -- lines in proportion to taxable value, with the rounding remainder given to
  -- the line with the largest taxable value. Each line's tax is then recomputed
  -- on its reduced base — we do NOT scale the aggregate tax by a ratio, because
  -- that produces different paise than per-line recomputation.
  -- -------------------------------------------------------------------------
  -- Invoice-level discount
  --
  -- SEMANTICS (must match allocateInvoiceDiscount() in
  -- src/lib/invoiceCalculations.ts):
  --
  --   EXCLUSIVE pricing: the discount reduces the pre-discount TAXABLE amount.
  --     base per line = taxable_amount_paise
  --     validation    = discount <= SUM(taxable_amount_paise)
  --
  --   INCLUSIVE pricing: the discount reduces the pre-discount CUSTOMER-FACING
  --     amount, which already contains tax. Validating it against the taxable
  --     total would wrongly reject a discount that is smaller than the invoice
  --     total but larger than its taxable component.
  --     base per line = gross_amount_paise - discount_paise  (the inclusive net)
  --     validation    = discount <= SUM(inclusive net)
  --
  -- Allocation is proportional to the chosen base. The rounding remainder goes
  -- to the line with the largest base (ties broken by lowest line_number), so
  -- the allocation is deterministic and always sums exactly to the requested
  -- discount. No line's discount can exceed its own base.
  --
  -- After allocation each line's taxable value and tax are recomputed from the
  -- discounted net. For inclusive pricing the taxable value is back-solved, so
  -- taxable + tax === net exactly.
  -- -------------------------------------------------------------------------
  if v_invoice_discount > 0 then
    declare
      v_base_total numeric(20,0) := 0;
      v_allocated numeric(20,0) := 0;
      v_remainder numeric(20,0);
      v_item record;
      v_reduction numeric(20,0);
      v_net numeric(20,0);
      v_new_taxable numeric(20,0);
      v_new_cgst numeric(20,0);
      v_new_sgst numeric(20,0);
      v_new_igst numeric(20,0);
      v_new_cess numeric(20,0);
      v_item_cess_bp integer;
      v_item_total_bp integer;
      v_new_total_tax numeric(20,0);
      v_new_gst_portion numeric(20,0);
    begin
      -- The base the discount is measured against.
      if coalesce(p_price_includes_tax, false) then
        select coalesce(sum(gross_amount_paise - discount_paise), 0)
          into v_base_total
        from public.invoice_items
        where invoice_id = v_invoice_id;
      else
        v_base_total := v_taxable_total;
      end if;

      if v_invoice_discount > v_base_total then
        raise exception
          'Invoice discount (%) cannot exceed the % amount (%)',
          v_invoice_discount,
          case when coalesce(p_price_includes_tax, false) then 'invoice total' else 'taxable value' end,
          v_base_total
          using errcode = '22023';
      end if;

      -- -------------------------------------------------------------------
      -- Passes 1 and 2: largest-remainder (Hamilton) allocation.
      --
      -- Independent rounding of each share does not sum to the requested
      -- discount, and patching the difference onto one line can push that line
      -- past its own base. Largest-remainder avoids both:
      --
      --   1. exact_i   = discount * base_i / total_base
      --   2. floor_i   = floor(exact_i)
      --   3. remainder = discount - sum(floor_i)      (0 <= remainder < n)
      --   4. give 1 paise to the "remainder" lines with the largest fractional
      --      part, ties broken by lowest line_number.
      --
      -- CRITICAL: the bases and fractional remainders are computed ONCE into a
      -- temporary table BEFORE any invoice_items.discount_paise is updated.
      -- Recomputing them after Pass 1 would read discount_paise values that
      -- Pass 1 already changed, corrupting both the base and the ranking.
      --
      -- This MUST match allocateInvoiceDiscount() in
      -- src/lib/invoiceCalculations.ts.
      -- -------------------------------------------------------------------
      -- -------------------------------------------------------------------
      -- Passes 1 and 2 in a SINGLE statement.
      --
      -- The bases, floor allocations and fractional remainders are computed
      -- once in MATERIALIZED CTEs. MATERIALIZED is essential: without it
      -- PostgreSQL may inline the CTE and re-evaluate it against
      -- invoice_items AFTER the UPDATE has changed discount_paise, which would
      -- corrupt both the base and the ranking.
      --
      --   bases   : the ORIGINAL per-line base (never re-read after update)
      --   floors  : floor(discount * base / total_base)
      --   fracs   : mod(discount * base, total_base)  -- the fractional part
      --   ranked  : floors + 1 paise for the top "remainder" rows by
      --             frac desc, line_number asc
      --
      -- The final UPDATE joins invoice_items to "ranked", so every line is
      -- written exactly once with its complete allocation.
      --
      -- This MUST match allocateInvoiceDiscount() in
      -- src/lib/invoiceCalculations.ts.
      -- -------------------------------------------------------------------
      with bases as materialized (
        select
          ii.id,
          ii.line_number,
          case when coalesce(p_price_includes_tax, false)
               then ii.gross_amount_paise - ii.discount_paise
               else ii.taxable_amount_paise
          end as base_paise
        from public.invoice_items ii
        where ii.invoice_id = v_invoice_id
      ),
      totals as materialized (
        select coalesce(sum(base_paise), 0) as base_total from bases
      ),
      floors as materialized (
        select
          b.id,
          b.line_number,
          b.base_paise,
          case when t.base_total = 0 then 0
               else floor(v_invoice_discount * b.base_paise / t.base_total)
          end as floor_paise,
          case when t.base_total = 0 then 0
               else mod(v_invoice_discount * b.base_paise, t.base_total)
          end as frac_paise
        from bases b
        cross join totals t
      ),
      remainder_count as materialized (
        select v_invoice_discount - coalesce(sum(floor_paise), 0) as n from floors
      ),
      ranked as materialized (
        select
          f.id,
          f.floor_paise
            + case
                when row_number() over (order by f.frac_paise desc, f.line_number asc)
                     <= (select n from remainder_count)
                then 1
                else 0
              end as allocation_paise
        from floors f
      )
      update public.invoice_items ii
      set discount_paise = ii.discount_paise + r.allocation_paise
      from ranked r
      where ii.id = r.id;

      -- Reconcile ONLY the newly allocated invoice-level discount.
      --
      -- invoice_items.discount_paise holds the COMBINED discount: the item-level
      -- discount written during the line loop PLUS the invoice-level allocation
      -- just applied. Comparing the combined sum against v_invoice_discount
      -- would falsely fail whenever any item-level discount exists.
      --
      -- v_item_discount_total was accumulated during the line loop and holds the
      -- item-level total, so the invoice-level allocation is the difference.
      select coalesce(sum(discount_paise), 0)
        into v_allocated
      from public.invoice_items
      where invoice_id = v_invoice_id;

      v_allocated := v_allocated - v_item_discount_total;
      v_remainder := v_invoice_discount - v_allocated;

      if v_remainder <> 0 then
        raise exception
          'Invoice discount allocation did not reconcile: requested %, allocated %',
          v_invoice_discount, v_allocated
          using errcode = '22023';
      end if;

      -- Pass 3: recompute each line's taxable value and tax from the
      -- discounted net.
      v_taxable_total := 0;
      v_cgst_total := 0;
      v_sgst_total := 0;
      v_igst_total := 0;
      v_cess_total := 0;

      for v_item in
        select id, gross_amount_paise, discount_paise, tax_rate_basis_points,
               cess_rate_basis_points,
               cgst_paise, sgst_paise, igst_paise, cess_paise, taxable_amount_paise
        from public.invoice_items
        where invoice_id = v_invoice_id
        order by line_number
      loop
        v_net := v_item.gross_amount_paise - v_item.discount_paise;

        -- Use the STORED cess rate. Reconstructing it from cess_paise would be
        -- lossy on small amounts.
        v_item_cess_bp := v_item.cess_rate_basis_points;
        v_item_total_bp := v_item.tax_rate_basis_points + v_item_cess_bp;

        if p_gst_mode = 'exempt' then
          -- Exempt supply: no tax of any kind, including cess. The whole net is
          -- taxable value.
          v_new_taxable := v_net;
          v_new_cgst := 0;
          v_new_sgst := 0;
          v_new_igst := 0;
          v_new_cess := 0;
        elsif coalesce(p_price_includes_tax, false) then
          if v_item_total_bp = 0 then
            v_new_taxable := v_net;
            v_new_cgst := 0;
            v_new_sgst := 0;
            v_new_igst := 0;
            v_new_cess := 0;
          else
            v_new_taxable := round(v_net * 10000 / (10000 + v_item_total_bp));
            v_new_total_tax := v_net - v_new_taxable;

            if p_gst_mode = 'inter_state' then
              v_new_cess := round(v_new_total_tax * v_item_cess_bp / v_item_total_bp);
              v_new_igst := v_new_total_tax - v_new_cess;
              v_new_cgst := 0;
              v_new_sgst := 0;
            else
              v_new_gst_portion := round(v_new_total_tax * v_item.tax_rate_basis_points / v_item_total_bp);
              v_new_cess := v_new_total_tax - v_new_gst_portion;
              if v_item.tax_rate_basis_points = 0 then
                v_new_cgst := 0;
                v_new_sgst := 0;
              else
                v_new_cgst := round(v_new_gst_portion * floor(v_item.tax_rate_basis_points / 2.0) / v_item.tax_rate_basis_points);
                v_new_sgst := v_new_gst_portion - v_new_cgst;
              end if;
              v_new_igst := 0;
            end if;
          end if;
        else
          v_new_taxable := v_net;

          if p_gst_mode = 'inter_state' then
            v_new_igst := round(v_new_taxable * v_item.tax_rate_basis_points / 10000);
            v_new_cgst := 0;
            v_new_sgst := 0;
          elsif p_gst_mode = 'intra_state' then
            v_new_cgst := round(v_new_taxable * floor(v_item.tax_rate_basis_points / 2.0) / 10000);
            v_new_sgst := round(v_new_taxable * (v_item.tax_rate_basis_points - floor(v_item.tax_rate_basis_points / 2.0)) / 10000);
            v_new_igst := 0;
          else
            v_new_cgst := 0;
            v_new_sgst := 0;
            v_new_igst := 0;
          end if;

          v_new_cess := round(v_new_taxable * v_item_cess_bp / 10000);
        end if;

        update public.invoice_items
        set taxable_amount_paise = v_new_taxable,
            cgst_paise = v_new_cgst,
            sgst_paise = v_new_sgst,
            igst_paise = v_new_igst,
            cess_paise = v_new_cess,
            line_total_paise = v_new_taxable + v_new_cgst + v_new_sgst + v_new_igst + v_new_cess
        where id = v_item.id;

        v_taxable_total := v_taxable_total + v_new_taxable;
        v_cgst_total := v_cgst_total + v_new_cgst;
        v_sgst_total := v_sgst_total + v_new_sgst;
        v_igst_total := v_igst_total + v_new_igst;
        v_cess_total := v_cess_total + v_new_cess;
      end loop;
    end;
  end if;

  v_total := v_taxable_total + v_cgst_total + v_sgst_total + v_igst_total + v_cess_total;

  update public.invoices
  set subtotal_paise = v_subtotal,
      discount_paise = v_item_discount_total,
      invoice_discount_paise = v_invoice_discount,
      taxable_amount_paise = v_taxable_total,
      cgst_paise = v_cgst_total,
      sgst_paise = v_sgst_total,
      igst_paise = v_igst_total,
      cess_paise = v_cess_total,
      total_tax_paise = v_cgst_total + v_sgst_total + v_igst_total + v_cess_total,
      total_amount_paise = v_total
  where id = v_invoice_id;

  perform public.write_audit_log(
    p_business_id, 'invoice', v_invoice_id, 'invoice.created', null,
    jsonb_build_object(
      'invoice_number', v_number,
      'total_amount_paise', v_total,
      'price_includes_tax', coalesce(p_price_includes_tax, false),
      'invoice_discount_paise', v_invoice_discount
    )
  );

  return v_invoice_id;
end;
$$;

revoke all on function public.create_invoice(uuid, uuid, date, date, text, text, jsonb, text, text, boolean, numeric) from public;
grant execute on function public.create_invoice(uuid, uuid, date, date, text, text, jsonb, text, text, boolean, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- confirm_gst_scheme
--   The owner explicitly confirms the business's GST scheme. This clears the
--   migration review flag and is the ONLY way to unblock tax-invoice issuance
--   for a business whose scheme was inferred during the upgrade.
--
--   Authorisation: owner or admin only (assert_can_manage). A read-only or
--   accountant member cannot change the tax registration category.
-- ---------------------------------------------------------------------------
create or replace function public.confirm_gst_scheme(
  p_business_id uuid,
  p_scheme public.gst_scheme
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_previous public.gst_scheme;
  v_previous_review boolean;
begin
  perform public.assert_can_manage(p_business_id);

  if p_scheme is null then
    raise exception 'A GST scheme is required' using errcode = '22023';
  end if;

  select gst_scheme, gst_scheme_needs_review
    into v_previous, v_previous_review
  from public.businesses
  where id = p_business_id;

  if not found then
    raise exception 'Business not found' using errcode = 'P0002';
  end if;

  -- Keep is_gst_registered consistent with the chosen scheme. The table CHECK
  -- constraint enforces this too; setting both here keeps the error message
  -- meaningful rather than surfacing a raw constraint violation.
  update public.businesses
  set gst_scheme = p_scheme,
      is_gst_registered = (p_scheme <> 'unregistered'),
      gst_scheme_needs_review = false
  where id = p_business_id;

  perform public.write_audit_log(
    p_business_id, 'business', p_business_id, 'settings.updated',
    jsonb_build_object(
      'gst_scheme', v_previous,
      'gst_scheme_needs_review', v_previous_review
    ),
    jsonb_build_object(
      'gst_scheme', p_scheme,
      'gst_scheme_needs_review', false
    )
  );
end;
$$;

revoke all on function public.confirm_gst_scheme(uuid, public.gst_scheme) from public;
grant execute on function public.confirm_gst_scheme(uuid, public.gst_scheme) to authenticated;

-- ---------------------------------------------------------------------------
-- Drop the redundant 9-argument wrapper
--
--   WHY: the 11-argument create_invoice() already accepts 9 arguments because
--   p_price_includes_tax and p_invoice_discount_paise both have defaults. With
--   both functions present, a 9-argument call matches BOTH candidates and
--   PostgreSQL raises "function public.create_invoice(...) is not unique".
--
--   The defaults reproduce the old behaviour exactly (exclusive pricing, no
--   invoice-level discount), so the wrapper adds nothing but ambiguity.
--   Existing 9-argument callers resolve unambiguously to the 11-argument
--   function.
-- ---------------------------------------------------------------------------
drop function if exists public.create_invoice(
  uuid, uuid, date, date, text, text, jsonb, text, text
);

-- ---------------------------------------------------------------------------
-- 4b. Privileges: public.invoices is RPC-write-only
--
--   FINAL DECISION: authenticated users have ZERO direct INSERT, UPDATE or
--   DELETE on public.invoices. SELECT only, filtered by tenant RLS.
--
--   WHY
--   `invoices_update_writer` is a row-level policy:
--       FOR UPDATE TO authenticated
--       USING (can_write_financials(business_id))
--       WITH CHECK (can_write_financials(business_id))
--
--   RLS decides WHO may update and WHICH ROWS. It says nothing about WHICH
--   COLUMNS. Without a privilege restriction, an owner, admin or accountant
--   could issue a direct UPDATE against any invoice in their business,
--   including document_state / issued_at / voided_at / void_reason.
--
--   WHAT THE APPLICATION ACTUALLY DOES
--   A full search of src/ shows the ONLY access to public.invoices is a SELECT
--   (invoiceService.getInvoice). Every write goes through an RPC:
--       create_invoice()  issue_invoice()  void_invoice()
--   There is no direct .update(), .insert() or .delete() on public.invoices
--   anywhere in the frontend.
--
--   Therefore the minimum necessary direct write privilege is NONE.
--
--   WHY REVOKE FROM PUBLIC FIRST
--   PostgreSQL grants some privileges to PUBLIC by default, and a role can
--   inherit privileges through role membership. Revoking only from
--   `authenticated` would leave a path open if PUBLIC ever held the privilege.
--   Revoking from PUBLIC, anon and authenticated closes every client path.
--
--   postgres, service_role and other trusted server-side roles are NOT
--   touched: they are not members of PUBLIC in a way this affects, and the
--   SECURITY DEFINER functions run as the function owner (postgres), which
--   retains full privilege.
--
--   If a future feature needs to edit a draft directly, grant UPDATE on the
--   specific column(s) at that time — never restore table-level UPDATE.
-- ---------------------------------------------------------------------------
revoke all on public.invoices from public;
revoke all on public.invoices from anon;
revoke all on public.invoices from authenticated;

-- Reads remain available to authenticated members; RLS still filters rows.
grant select on public.invoices to authenticated;

comment on column public.invoices.document_state is
  'Lifecycle state. Writable only via issue_invoice() / void_invoice(). No client role has INSERT/UPDATE/DELETE on public.invoices.';
comment on column public.invoices.issued_at is
  'Set by issue_invoice(). No client role has INSERT/UPDATE/DELETE on public.invoices.';
comment on column public.invoices.voided_at is
  'Set by void_invoice(). No client role has INSERT/UPDATE/DELETE on public.invoices.';
comment on column public.invoices.void_reason is
  'Set by void_invoice(). No client role has INSERT/UPDATE/DELETE on public.invoices.';

-- ---------------------------------------------------------------------------
-- 4c. Privileges: public.invoice_items is RPC-write-only
--
--   Same reasoning as 4b. A full search of src/ shows the ONLY access to
--   public.invoice_items is a SELECT (invoiceService.getInvoiceItems). Every
--   write happens inside create_invoice(), which is SECURITY DEFINER and runs
--   as the function owner.
--
--   The RLS policies on invoice_items (insert/update/delete for financial
--   writers) therefore become inert: the role lacks the underlying table
--   privilege, so they can never be reached. They are retained so a future
--   column-level grant would still be RLS-filtered.
--
--   The invoice_item_discounts view uses security_invoker = true, so it reads
--   invoice_items with the CALLER's privileges. authenticated retains SELECT,
--   so the view keeps working and tenant RLS still applies through it.
-- ---------------------------------------------------------------------------
revoke all on public.invoice_items from public;
revoke all on public.invoice_items from anon;
revoke all on public.invoice_items from authenticated;

-- Reads remain available to authenticated members; RLS still filters rows.
grant select on public.invoice_items to authenticated;

comment on table public.invoice_items is
  'Invoice line items. Writable only by SECURITY DEFINER invoice functions. No client role has INSERT/UPDATE/DELETE.';

-- ---------------------------------------------------------------------------
-- 5. Guard: an issued invoice's pricing mode and invoice discount are frozen.
--    (guard_invoice_update already freezes totals; this extends it.)
-- ---------------------------------------------------------------------------
create or replace function public.guard_invoice_update()
returns trigger
language plpgsql
as $$
begin
  -- -------------------------------------------------------------------------
  -- 1. Identity and attribution are immutable for the life of the row.
  --
  --    These are checked on EVERY update, not only on issued invoices. A
  --    primary key is not proof of immutability: a direct UPDATE can change it,
  --    and created_by/created_at have no constraint protecting them at all.
  -- -------------------------------------------------------------------------
  if new.id         is distinct from old.id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'An invoice''s identity and creation attribution cannot be changed.'
      using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 2. Lifecycle timestamps may only be set by the transition that owns them.
  --
  --    issued_at   may go NULL -> value exactly once, when draft -> issued.
  --                It may never be cleared or changed afterwards.
  --    voided_at   may go NULL -> value exactly once, when issued -> void.
  --    void_reason may go NULL -> value exactly once, when issued -> void.
  --
  --    The CHECK constraints in 0001 tie these to document_state, but they do
  --    not stop a caller from rewriting the value while the state is unchanged.
  -- -------------------------------------------------------------------------
  if old.issued_at is not null and new.issued_at is distinct from old.issued_at then
    raise exception 'issued_at cannot be changed once the invoice has been issued.'
      using errcode = '22023';
  end if;
  if old.issued_at is null and new.issued_at is not null
     and new.document_state <> 'issued' then
    raise exception 'issued_at can only be set when the invoice is issued.'
      using errcode = '22023';
  end if;

  if old.voided_at is not null and new.voided_at is distinct from old.voided_at then
    raise exception 'voided_at cannot be changed once the invoice has been voided.'
      using errcode = '22023';
  end if;
  if old.voided_at is null and new.voided_at is not null
     and new.document_state <> 'void' then
    raise exception 'voided_at can only be set when the invoice is voided.'
      using errcode = '22023';
  end if;

  if old.void_reason is not null and new.void_reason is distinct from old.void_reason then
    raise exception 'void_reason cannot be changed once the invoice has been voided.'
      using errcode = '22023';
  end if;
  if old.void_reason is null and new.void_reason is not null
     and new.document_state <> 'void' then
    raise exception 'void_reason can only be set when the invoice is voided.'
      using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 3. Financial fields are frozen once the invoice is issued.
  --
  --    Comparing only the aggregate totals is not enough: a caller could move
  --    value between taxable_amount_paise and a tax component, or flip gst_mode
  --    from intra_state to inter_state, while leaving total_amount_paise
  --    unchanged.
  --
  --    business_id is included because moving an issued invoice to another
  --    tenant would be a cross-tenant data breach, and it would also orphan the
  --    invoice from its original customer and payment allocations.
  --
  --    IS DISTINCT FROM is used throughout because it is null-safe: a NULL
  --    place_of_supply_state_code compared with <> would yield NULL, which is
  --    not TRUE, and the guard would silently pass.
  --
  --    Deliberately NOT frozen here (and why):
  --      document_state  issued -> void is the supported correction path
  --      notes           free-text annotation, not financial
  --      updated_at      maintained by set_updated_at()
  -- -------------------------------------------------------------------------
  if old.document_state = 'issued' then
    if new.business_id            is distinct from old.business_id
       or new.total_amount_paise      is distinct from old.total_amount_paise
       or new.taxable_amount_paise is distinct from old.taxable_amount_paise
       or new.total_tax_paise      is distinct from old.total_tax_paise
       or new.subtotal_paise       is distinct from old.subtotal_paise
       or new.discount_paise       is distinct from old.discount_paise
       or new.cgst_paise           is distinct from old.cgst_paise
       or new.sgst_paise           is distinct from old.sgst_paise
       or new.igst_paise           is distinct from old.igst_paise
       or new.cess_paise           is distinct from old.cess_paise
       or new.gst_mode             is distinct from old.gst_mode
       or new.place_of_supply_state_code is distinct from old.place_of_supply_state_code
       or new.customer_id          is distinct from old.customer_id
       or new.invoice_date         is distinct from old.invoice_date
       or new.due_date             is distinct from old.due_date
       or new.invoice_number       is distinct from old.invoice_number
       or new.financial_year       is distinct from old.financial_year
       or new.price_includes_tax   is distinct from old.price_includes_tax
       or new.invoice_discount_paise is distinct from old.invoice_discount_paise
       or new.customer_snapshot    is distinct from old.customer_snapshot then
      raise exception 'An issued invoice cannot be modified. Void it and issue a corrected invoice instead.'
        using errcode = '22023';
    end if;
  end if;

  -- -------------------------------------------------------------------------
  -- 4. Document state transitions.
  -- -------------------------------------------------------------------------
  if old.document_state = 'void' and new.document_state <> 'void' then
    raise exception 'A void invoice cannot be reinstated' using errcode = '22023';
  end if;

  if old.document_state = 'issued' and new.document_state = 'draft' then
    raise exception 'An issued invoice cannot be returned to draft. Void it and issue a corrected invoice instead.'
      using errcode = '22023';
  end if;

  return new;
end;
$$;

-- ===========================================================================
-- DOWN (manual rollback — NOT a tested procedure)
--
--   This is a reference sketch, not a rehearsed rollback. It has never been
--   executed. Before relying on it, rehearse it against a disposable database.
--
--   Order matters: drop dependants before their dependencies.
--
--   drop view if exists public.invoice_item_discounts;
--   drop function if exists public.confirm_gst_scheme(uuid, public.gst_scheme);
--   drop function if exists public.create_invoice(uuid, uuid, date, date, text, text, jsonb, text, text, boolean, numeric);
--   -- restore the 0003 definition of create_invoice() and guard_invoice_update()
--   -- restore the 0003 grants on create_invoice(uuid, uuid, date, date, text, text, jsonb, text, text)
--   -- restore table-level privileges on public.invoices:
--   --   grant update, insert, delete on public.invoices to authenticated;
--   alter table public.invoice_items drop column if exists cess_rate_basis_points;
--   alter table public.invoice_items drop column if exists discount_value;
--   alter table public.invoice_items drop column if exists discount_type;
--   alter table public.invoices drop column if exists invoice_discount_paise;
--   alter table public.invoices drop column if exists price_includes_tax;
--   alter table public.businesses drop constraint if exists businesses_gst_scheme_registration_consistent;
--   alter table public.businesses drop column if exists gst_scheme_needs_review;
--   alter table public.businesses drop column if exists gst_scheme;
--   drop type if exists public.discount_type;
--   drop type if exists public.gst_scheme;
-- ===========================================================================

-- end of migration 0005
