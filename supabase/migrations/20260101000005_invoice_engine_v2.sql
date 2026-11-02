-- ===========================================================================
-- BizPilot — 0005 invoice engine v2
--
-- ADDITIVE ONLY. Nothing here changes the meaning of existing data.
--
-- TRANSACTIONALITY
--   The Supabase CLI runs each migration file inside a single transaction, but
--   this file also wraps itself in an explicit BEGIN/COMMIT so that a failure
--   at ANY statement rolls back every earlier statement. A previous attempt
--   failed at the invoice_items backfill and left enums and columns behind
--   because the file relied on the CLI's implicit transaction. The explicit
--   block removes that dependency.
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
--
-- BACKWARDS COMPATIBILITY
--   * Every new column is nullable or has a default that reproduces the old
--     behaviour exactly.
--   * Existing invoices keep price_includes_tax = false and
--     invoice_discount_paise = 0, so their stored totals remain correct.
--   * Existing invoice_items get discount_type = 'percent' and
--     discount_value = discount_percent_basis_points, which is what they were.
--   * Existing businesses get gst_scheme = 'unregistered' ONLY when they are
--     not GST-registered. Registered businesses are set to 'regular' but flagged
--     for review via a dedicated column, because we must not silently assume a
--     composition taxpayer is regular.
--   * create_invoice() keeps its original signature and gains two optional
--     trailing parameters, so existing callers continue to work unchanged.
--
-- ROLLBACK
--   See the DOWN section at the bottom of this file. It is commented out so the
--   migration is forward-only by default; run it manually if a rollback is
--   required before any data depends on the new columns.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. GST scheme on businesses
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'gst_scheme') then
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
alter table public.businesses
  add column if not exists gst_scheme_needs_review boolean not null default false;

update public.businesses
set gst_scheme = case
  when is_gst_registered then 'regular'::public.gst_scheme
  else 'unregistered'::public.gst_scheme
end
where gst_scheme is null;

update public.businesses
set gst_scheme_needs_review = true
where is_gst_registered = true
  and gst_scheme = 'regular'
  and gst_scheme_needs_review = false;

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
  if not exists (select 1 from pg_type where typname = 'discount_type') then
    create type public.discount_type as enum ('none', 'percent', 'fixed');
  end if;
end;
$$;

alter table public.invoice_items
  add column if not exists discount_type public.discount_type not null default 'none';

alter table public.invoice_items
  add column if not exists discount_value numeric(20,0) not null default 0;

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

  -- GST scheme guard: a composition or unregistered business must not issue a
  -- tax invoice. Exempt supply is always allowed.
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
        'A composition-scheme business cannot issue a tax invoice or collect GST from customers. Bill of Supply is not yet supported in BizPilot, so this invoice cannot be created. Do not record it as exempt supply — a composition supply is taxable at a flat rate, not exempt.'
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
          v_cgst := round(v_gst_portion * floor(v_tax_bp / 2.0) / v_tax_bp);
          v_sgst := v_gst_portion - v_cgst;
          v_igst := 0;
        end if;
      end if;
    else
      v_taxable := v_net;

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

    v_line_total := v_taxable + v_cgst + v_sgst + v_igst + v_cess;

    insert into public.invoice_items (
      business_id, invoice_id, line_number, description, hsn_sac, quantity, unit,
      unit_price_paise, discount_percent_basis_points, discount_type, discount_value,
      gross_amount_paise, discount_paise,
      taxable_amount_paise, tax_rate_basis_points, cgst_paise, sgst_paise, igst_paise,
      cess_paise, line_total_paise
    )
    values (
      p_business_id, v_invoice_id, v_line_no, trim(v_line ->> 'description'),
      nullif(trim(coalesce(v_line ->> 'hsn_sac', '')), ''), v_qty,
      nullif(trim(coalesce(v_line ->> 'unit', '')), ''),
      v_price,
      case when v_disc_type = 'percent' then v_disc_value::integer else 0 end,
      v_disc_type, v_disc_value,
      v_gross, v_discount, v_taxable, v_tax_bp,
      v_cgst, v_sgst, v_igst, v_cess, v_line_total
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
  if v_invoice_discount > 0 then
    if v_invoice_discount > v_taxable_total then
      raise exception 'Invoice discount cannot exceed the taxable value'
        using errcode = '22023';
    end if;

    declare
      v_allocated numeric(20,0) := 0;
      v_remainder numeric(20,0);
      v_largest_id uuid;
      v_item record;
      v_reduction numeric(20,0);
      v_new_taxable numeric(20,0);
      v_new_cgst numeric(20,0);
      v_new_sgst numeric(20,0);
      v_new_igst numeric(20,0);
      v_new_cess numeric(20,0);
    begin
      -- Pass 1: proportional allocation.
      for v_item in
        select id, taxable_amount_paise
        from public.invoice_items
        where invoice_id = v_invoice_id
        order by line_number
      loop
        v_reduction := round(v_invoice_discount * v_item.taxable_amount_paise / v_taxable_total);
        update public.invoice_items
        set discount_paise = discount_paise + v_reduction
        where id = v_item.id;
        v_allocated := v_allocated + v_reduction;
      end loop;

      -- Pass 2: give the rounding remainder to the largest line.
      v_remainder := v_invoice_discount - v_allocated;
      if v_remainder <> 0 then
        select id into v_largest_id
        from public.invoice_items
        where invoice_id = v_invoice_id
        order by taxable_amount_paise desc, line_number asc
        limit 1;

        update public.invoice_items
        set discount_paise = discount_paise + v_remainder
        where id = v_largest_id;
      end if;

      -- Pass 3: recompute each line's taxable value and tax on the reduced base.
      v_taxable_total := 0;
      v_cgst_total := 0;
      v_sgst_total := 0;
      v_igst_total := 0;
      v_cess_total := 0;

      for v_item in
        select id, gross_amount_paise, discount_paise, tax_rate_basis_points,
               cgst_paise, sgst_paise, igst_paise, cess_paise, taxable_amount_paise
        from public.invoice_items
        where invoice_id = v_invoice_id
        order by line_number
      loop
        v_new_taxable := v_item.gross_amount_paise - v_item.discount_paise;

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

        -- Cess keeps its original ratio to the taxable value.
        v_new_cess := case
          when v_item.taxable_amount_paise > 0
            then round(v_item.cess_paise * v_new_taxable / v_item.taxable_amount_paise)
          else 0
        end;

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

-- Keep the old 9-argument signature working for any caller that has not been
-- updated. It simply forwards to the new function with the defaults.
create or replace function public.create_invoice(
  p_business_id uuid,
  p_customer_id uuid,
  p_invoice_date date,
  p_due_date date,
  p_gst_mode text,
  p_place_of_supply_state_code text,
  p_lines jsonb,
  p_notes text default null,
  p_invoice_number text default null
)
returns uuid
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.create_invoice(
    p_business_id, p_customer_id, p_invoice_date, p_due_date, p_gst_mode,
    p_place_of_supply_state_code, p_lines, p_notes, p_invoice_number,
    false, 0
  );
$$;

revoke all on function public.create_invoice(uuid, uuid, date, date, text, text, jsonb, text, text) from public;
grant execute on function public.create_invoice(uuid, uuid, date, date, text, text, jsonb, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Guard: an issued invoice's pricing mode and invoice discount are frozen.
--    (guard_invoice_update already freezes totals; this extends it.)
-- ---------------------------------------------------------------------------
create or replace function public.guard_invoice_update()
returns trigger
language plpgsql
as $$
begin
  if old.document_state = 'issued' then
    if new.total_amount_paise <> old.total_amount_paise
       or new.taxable_amount_paise <> old.taxable_amount_paise
       or new.total_tax_paise <> old.total_tax_paise
       or new.customer_id <> old.customer_id
       or new.invoice_date <> old.invoice_date
       or new.invoice_number <> old.invoice_number
       or new.price_includes_tax <> old.price_includes_tax
       or new.invoice_discount_paise <> old.invoice_discount_paise then
      raise exception 'An issued invoice cannot be modified. Void it and issue a corrected invoice instead.'
        using errcode = '22023';
    end if;
  end if;

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

commit;

-- ===========================================================================
-- DOWN (manual rollback — run only if this migration must be reverted before
-- any invoice depends on the new columns)
--
--   begin;
--   drop function if exists public.confirm_gst_scheme(uuid, public.gst_scheme);
--   drop function if exists public.create_invoice(uuid, uuid, date, date, text, text, jsonb, text, text, boolean, numeric);
--   -- restore the 0003 definition of create_invoice() and guard_invoice_update()
--   alter table public.invoice_items drop column if exists discount_value;
--   alter table public.invoice_items drop column if exists discount_type;
--   alter table public.invoices drop column if exists invoice_discount_paise;
--   alter table public.invoices drop column if exists price_includes_tax;
--   alter table public.businesses drop constraint if exists businesses_gst_scheme_registration_consistent;
--   alter table public.businesses drop column if exists gst_scheme_needs_review;
--   alter table public.businesses drop column if exists gst_scheme;
--   drop type if exists public.discount_type;
--   drop type if exists public.gst_scheme;
--   commit;
-- ===========================================================================

-- end of migration 0005
