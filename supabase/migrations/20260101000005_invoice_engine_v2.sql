-- ===========================================================================
-- BizPilot — 0005 invoice engine v2
--
-- ADDITIVE ONLY. Nothing here changes the meaning of existing data.
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

-- A composition taxpayer cannot be GST-registered in the tax-invoice sense.
alter table public.businesses
  drop constraint if exists businesses_composition_not_registered;
alter table public.businesses
  add constraint businesses_composition_not_registered
  check (gst_scheme <> 'composition' or is_gst_registered = false);

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
update public.invoice_items
set discount_type = case
      when discount_percent_basis_points > 0 then 'percent'::public.discount_type
      else 'none'::public.discount_type
    end,
    discount_value = discount_percent_basis_points
where discount_type = 'none' and discount_value = 0;

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
    if v_business.gst_scheme = 'composition' then
      raise exception
        'A composition-scheme business cannot issue a tax invoice. Use exempt supply or record a bill of supply.'
        using errcode = '22023';
    end if;
    if v_business.gst_scheme = 'unregistered' then
      raise exception
        'An unregistered business cannot charge GST. Use exempt supply for this invoice.'
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
    v_gross := round(v_price * v_qty);

    if v_disc_type = 'percent' then
      v_discount := round(v_gross * v_disc_value / 10000.0);
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
        v_taxable := round(v_net * 10000.0 / (10000 + v_total_rate_bp));
        v_total_tax := v_net - v_taxable;

        if p_gst_mode = 'inter_state' then
          v_cess := round(v_total_tax * v_cess_bp / v_total_rate_bp::numeric);
          v_igst := v_total_tax - v_cess;
          v_cgst := 0; v_sgst := 0;
        else
          v_gst_portion := round(v_total_tax * v_tax_bp / v_total_rate_bp::numeric);
          v_cess := v_total_tax - v_gst_portion;
          v_cgst := round(v_gst_portion * floor(v_tax_bp / 2.0) / v_tax_bp::numeric);
          v_sgst := v_gst_portion - v_cgst;
          v_igst := 0;
        end if;
      end if;
    else
      v_taxable := v_net;

      if p_gst_mode = 'inter_state' then
        v_igst := round(v_taxable * v_tax_bp / 10000.0);
        v_cgst := 0;
        v_sgst := 0;
      elsif p_gst_mode = 'intra_state' then
        v_cgst := round(v_taxable * floor(v_tax_bp / 2.0) / 10000.0);
        v_sgst := round(v_taxable * (v_tax_bp - floor(v_tax_bp / 2.0)) / 10000.0);
        v_igst := 0;
      else
        v_cgst := 0;
        v_sgst := 0;
        v_igst := 0;
      end if;

      v_cess := round(v_taxable * v_cess_bp / 10000.0);
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

  -- Invoice-level discount: reduce the taxable base proportionally and scale
  -- the tax components by the same ratio so the breakdown stays consistent.
  if v_invoice_discount > 0 then
    if v_invoice_discount > v_taxable_total then
      raise exception 'Invoice discount cannot exceed the taxable value'
        using errcode = '22023';
    end if;

    v_cgst_total := round(v_cgst_total * (v_taxable_total - v_invoice_discount) / v_taxable_total);
    v_sgst_total := round(v_sgst_total * (v_taxable_total - v_invoice_discount) / v_taxable_total);
    v_igst_total := round(v_igst_total * (v_taxable_total - v_invoice_discount) / v_taxable_total);
    v_cess_total := round(v_cess_total * (v_taxable_total - v_invoice_discount) / v_taxable_total);
    v_taxable_total := v_taxable_total - v_invoice_discount;
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

-- ===========================================================================
-- DOWN (manual rollback — run only if this migration must be reverted before
-- any invoice depends on the new columns)
--
--   drop function if exists public.create_invoice(uuid, uuid, date, date, text, text, jsonb, text, text, boolean, numeric);
--   -- restore the 0003 definition of create_invoice() and guard_invoice_update()
--   alter table public.invoice_items drop column if exists discount_value;
--   alter table public.invoice_items drop column if exists discount_type;
--   alter table public.invoices drop column if exists invoice_discount_paise;
--   alter table public.invoices drop column if exists price_includes_tax;
--   alter table public.businesses drop constraint if exists businesses_composition_not_registered;
--   alter table public.businesses drop column if exists gst_scheme_needs_review;
--   alter table public.businesses drop column if exists gst_scheme;
--   drop type if exists public.discount_type;
--   drop type if exists public.gst_scheme;
-- ===========================================================================
