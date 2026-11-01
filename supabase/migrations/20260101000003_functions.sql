-- ===========================================================================
-- BizPilot — 0003 transactional RPCs
--
-- Every financial operation that touches more than one row runs inside a
-- single SECURITY DEFINER function so it is atomic: either all changes commit
-- or none do. Each function:
--   * fixes search_path (prevents search_path hijacking),
--   * validates auth.uid() and business membership explicitly,
--   * re-checks every invariant server-side (never trusts the client),
--   * writes an audit record,
--   * is revoked from PUBLIC and granted only to `authenticated`.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Internal helper: write an audit row. Not exposed to clients.
-- ---------------------------------------------------------------------------
create or replace function public.write_audit_log(
  p_business_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_action public.audit_action,
  p_previous jsonb default null,
  p_new jsonb default null
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.audit_logs (business_id, user_id, entity_type, entity_id, action, previous_values, new_values)
  values (p_business_id, auth.uid(), p_entity_type, p_entity_id, p_action, p_previous, p_new);
$$;

revoke all on function public.write_audit_log(uuid, text, uuid, public.audit_action, jsonb, jsonb) from public;

-- ---------------------------------------------------------------------------
-- Internal helper: assert the caller may write financial data.
-- ---------------------------------------------------------------------------
create or replace function public.assert_can_write(p_business_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not public.can_write_financials(p_business_id) then
    raise exception 'You do not have permission to modify financial records for this business'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.assert_can_write(uuid) from public;

-- ---------------------------------------------------------------------------
-- Internal helper: assert the caller may manage the business (owner/admin).
-- ---------------------------------------------------------------------------
create or replace function public.assert_can_manage(p_business_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not public.can_manage_business(p_business_id) then
    raise exception 'Only an owner or administrator can perform this action'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.assert_can_manage(uuid) from public;

-- ---------------------------------------------------------------------------
-- create_business_with_owner
--   Creates a business and makes the caller its owner in one transaction.
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
  p_default_credit_period_days smallint default 30
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_business_id uuid;
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

  insert into public.businesses (
    legal_name, display_name, business_type, gstin, city, state_code, phone, email,
    is_gst_registered, invoice_prefix, default_credit_period_days
  )
  values (
    trim(p_legal_name), trim(p_display_name), p_business_type, p_gstin, p_city, p_state_code,
    p_phone, p_email, coalesce(p_is_gst_registered, false), coalesce(p_invoice_prefix, 'INV'),
    coalesce(p_default_credit_period_days, 30)
  )
  returning id into v_business_id;

  insert into public.business_members (business_id, user_id, role, invitation_status)
  values (v_business_id, v_user_id, 'owner', 'accepted');

  perform public.write_audit_log(
    v_business_id, 'business', v_business_id, 'business.created', null,
    jsonb_build_object('legal_name', p_legal_name, 'display_name', p_display_name)
  );

  return v_business_id;
end;
$$;

revoke all on function public.create_business_with_owner(text, text, text, text, text, text, text, text, boolean, text, smallint) from public;
grant execute on function public.create_business_with_owner(text, text, text, text, text, text, text, text, boolean, text, smallint) to authenticated;

-- ---------------------------------------------------------------------------
-- next_invoice_number
--   Atomically reserves the next invoice number for a business + financial year.
--   Uses an UPSERT with a row lock so concurrent callers can never collide.
-- ---------------------------------------------------------------------------
create or replace function public.next_invoice_number(
  p_business_id uuid,
  p_financial_year text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prefix text;
  v_number integer;
begin
  perform public.assert_can_write(p_business_id);

  if p_financial_year !~ '^\d{4}-\d{2}$' then
    raise exception 'Invalid financial year "%"', p_financial_year using errcode = '22023';
  end if;

  select invoice_prefix into v_prefix from public.businesses where id = p_business_id;
  if v_prefix is null then
    raise exception 'Business not found' using errcode = 'P0002';
  end if;

  insert into public.invoice_sequences (business_id, financial_year, prefix, last_number)
  values (p_business_id, p_financial_year, v_prefix, 1)
  on conflict (business_id, financial_year)
  do update set last_number = public.invoice_sequences.last_number + 1,
                updated_at = now()
  returning last_number, prefix into v_number, v_prefix;

  return v_prefix || '-' || p_financial_year || '-' || lpad(v_number::text, 3, '0');
end;
$$;

revoke all on function public.next_invoice_number(uuid, text) from public;
grant execute on function public.next_invoice_number(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- financial_year_of — Indian FY label ("2026-27") for a date.
-- ---------------------------------------------------------------------------
create or replace function public.financial_year_of(p_date date, p_start_month integer default 4)
returns text
language sql
immutable
as $$
  select case
    when extract(month from p_date) >= p_start_month
      then extract(year from p_date)::int::text || '-' || lpad(((extract(year from p_date)::int + 1) % 100)::text, 2, '0')
    else (extract(year from p_date)::int - 1)::text || '-' || lpad((extract(year from p_date)::int % 100)::text, 2, '0')
  end;
$$;

-- ---------------------------------------------------------------------------
-- create_invoice
--   Creates a draft invoice with its line items in one transaction.
--   Totals are recomputed server-side from the line inputs; the client's
--   totals are never trusted.
--
--   p_lines is a JSON array of objects:
--     { description, hsn_sac, quantity, unit, unit_price_paise,
--       discount_percent_basis_points, tax_rate_basis_points, cess_rate_basis_points }
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
  p_invoice_number text default null
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
  v_financial_year text;
  v_number text;
  v_line jsonb;
  v_line_no integer := 0;
  v_qty numeric(14,3);
  v_price numeric(20,0);
  v_disc_bp integer;
  v_tax_bp integer;
  v_cess_bp integer;
  v_gross numeric(20,0);
  v_discount numeric(20,0);
  v_taxable numeric(20,0);
  v_cgst numeric(20,0);
  v_sgst numeric(20,0);
  v_igst numeric(20,0);
  v_cess numeric(20,0);
  v_line_total numeric(20,0);
  v_subtotal numeric(20,0) := 0;
  v_discount_total numeric(20,0) := 0;
  v_taxable_total numeric(20,0) := 0;
  v_cgst_total numeric(20,0) := 0;
  v_sgst_total numeric(20,0) := 0;
  v_igst_total numeric(20,0) := 0;
  v_cess_total numeric(20,0) := 0;
  v_total numeric(20,0);
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
    document_state, place_of_supply_state_code, gst_mode, notes, created_by
  )
  values (
    p_business_id, p_customer_id, v_number, v_financial_year, p_invoice_date, p_due_date,
    'draft', p_place_of_supply_state_code, p_gst_mode, p_notes, v_user_id
  )
  returning id into v_invoice_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_line_no := v_line_no + 1;

    v_qty := (v_line ->> 'quantity')::numeric(14,3);
    v_price := (v_line ->> 'unit_price_paise')::numeric(20,0);
    v_disc_bp := coalesce((v_line ->> 'discount_percent_basis_points')::integer, 0);
    v_tax_bp := coalesce((v_line ->> 'tax_rate_basis_points')::integer, 0);
    v_cess_bp := coalesce((v_line ->> 'cess_rate_basis_points')::integer, 0);

    if v_qty is null or v_qty <= 0 then
      raise exception 'Line % has an invalid quantity', v_line_no using errcode = '22023';
    end if;
    if v_price is null or v_price < 0 then
      raise exception 'Line % has an invalid unit price', v_line_no using errcode = '22023';
    end if;
    if v_disc_bp < 0 or v_disc_bp > 10000 then
      raise exception 'Line % has an invalid discount', v_line_no using errcode = '22023';
    end if;
    if v_tax_bp < 0 or v_tax_bp > 10000 then
      raise exception 'Line % has an invalid tax rate', v_line_no using errcode = '22023';
    end if;

    -- Integer paise arithmetic with half-up rounding, mirroring money.ts.
    v_gross := round(v_price * v_qty);
    v_discount := round(v_gross * v_disc_bp / 10000.0);
    v_taxable := v_gross - v_discount;

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
    v_line_total := v_taxable + v_cgst + v_sgst + v_igst + v_cess;

    insert into public.invoice_items (
      business_id, invoice_id, line_number, description, hsn_sac, quantity, unit,
      unit_price_paise, discount_percent_basis_points, gross_amount_paise, discount_paise,
      taxable_amount_paise, tax_rate_basis_points, cgst_paise, sgst_paise, igst_paise,
      cess_paise, line_total_paise
    )
    values (
      p_business_id, v_invoice_id, v_line_no, trim(v_line ->> 'description'),
      nullif(trim(coalesce(v_line ->> 'hsn_sac', '')), ''), v_qty,
      nullif(trim(coalesce(v_line ->> 'unit', '')), ''),
      v_price, v_disc_bp, v_gross, v_discount, v_taxable, v_tax_bp,
      v_cgst, v_sgst, v_igst, v_cess, v_line_total
    );

    v_subtotal := v_subtotal + v_gross;
    v_discount_total := v_discount_total + v_discount;
    v_taxable_total := v_taxable_total + v_taxable;
    v_cgst_total := v_cgst_total + v_cgst;
    v_sgst_total := v_sgst_total + v_sgst;
    v_igst_total := v_igst_total + v_igst;
    v_cess_total := v_cess_total + v_cess;
  end loop;

  v_total := v_taxable_total + v_cgst_total + v_sgst_total + v_igst_total + v_cess_total;

  update public.invoices
  set subtotal_paise = v_subtotal,
      discount_paise = v_discount_total,
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
    jsonb_build_object('invoice_number', v_number, 'total_amount_paise', v_total)
  );

  return v_invoice_id;
end;
$$;

revoke all on function public.create_invoice(uuid, uuid, date, date, text, text, jsonb, text, text) from public;
grant execute on function public.create_invoice(uuid, uuid, date, date, text, text, jsonb, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- issue_invoice
--   Draft -> issued. Snapshots the customer so later profile edits cannot
--   silently rewrite history. Totals are frozen once issued.
-- ---------------------------------------------------------------------------
create or replace function public.issue_invoice(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice public.invoices%rowtype;
  v_customer public.customers%rowtype;
  v_business public.businesses%rowtype;
begin
  select * into v_invoice from public.invoices where id = p_invoice_id;
  if not found then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;

  perform public.assert_can_write(v_invoice.business_id);

  if v_invoice.document_state <> 'draft' then
    raise exception 'Only draft invoices can be issued (current state: %)', v_invoice.document_state
      using errcode = '22023';
  end if;
  if v_invoice.total_amount_paise <= 0 then
    raise exception 'Cannot issue an invoice with a zero total' using errcode = '22023';
  end if;

  select * into v_customer from public.customers where id = v_invoice.customer_id;
  select * into v_business from public.businesses where id = v_invoice.business_id;

  update public.invoices
  set document_state = 'issued',
      issued_at = now(),
      customer_snapshot = jsonb_build_object(
        'customer_name', v_customer.customer_name,
        'phone', v_customer.phone,
        'email', v_customer.email,
        'gstin', v_customer.gstin,
        'billing_address', v_customer.billing_address,
        'shipping_address', v_customer.shipping_address,
        'city', v_customer.city,
        'state_code', v_customer.state_code,
        'business_legal_name', v_business.legal_name,
        'business_gstin', v_business.gstin,
        'business_address', v_business.address_line1,
        'business_city', v_business.city,
        'business_state_code', v_business.state_code
      )
  where id = p_invoice_id;

  perform public.write_audit_log(
    v_invoice.business_id, 'invoice', p_invoice_id, 'invoice.issued',
    jsonb_build_object('document_state', 'draft'),
    jsonb_build_object('document_state', 'issued', 'invoice_number', v_invoice.invoice_number)
  );
end;
$$;

revoke all on function public.issue_invoice(uuid) from public;
grant execute on function public.issue_invoice(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- void_invoice
--   Issued -> void. Never deletes. Blocked when payments are allocated.
-- ---------------------------------------------------------------------------
create or replace function public.void_invoice(p_invoice_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice public.invoices%rowtype;
  v_allocated numeric(20,0);
begin
  select * into v_invoice from public.invoices where id = p_invoice_id;
  if not found then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;

  perform public.assert_can_manage(v_invoice.business_id);

  if v_invoice.document_state = 'void' then
    raise exception 'Invoice is already void' using errcode = '22023';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required to void an invoice' using errcode = '22023';
  end if;

  select coalesce(sum(pa.allocated_amount_paise), 0) into v_allocated
  from public.payment_allocations pa
  join public.payments p on p.id = pa.payment_id
  where pa.invoice_id = p_invoice_id and p.reversed_at is null;

  if v_allocated > 0 then
    raise exception 'Cannot void an invoice that has payments allocated to it. Reverse the payments first.'
      using errcode = '22023';
  end if;

  update public.invoices
  set document_state = 'void', voided_at = now(), void_reason = trim(p_reason)
  where id = p_invoice_id;

  perform public.write_audit_log(
    v_invoice.business_id, 'invoice', p_invoice_id, 'invoice.voided',
    jsonb_build_object('document_state', v_invoice.document_state),
    jsonb_build_object('document_state', 'void', 'reason', trim(p_reason))
  );
end;
$$;

revoke all on function public.void_invoice(uuid, text) from public;
grant execute on function public.void_invoice(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- record_payment
--   Creates a payment and its allocations atomically.
--   * Idempotent: the same idempotency_key returns the existing payment.
--   * Allocations are validated against live invoice balances under a row lock.
--   * Any remainder stays as an unallocated advance.
-- ---------------------------------------------------------------------------
create or replace function public.record_payment(
  p_business_id uuid,
  p_customer_id uuid,
  p_payment_date date,
  p_amount_paise numeric,
  p_payment_method public.payment_method,
  p_reference_number text,
  p_idempotency_key text,
  p_notes text default null,
  p_allocations jsonb default '[]'::jsonb,
  p_cheque_status public.cheque_status default 'not_applicable'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_payment_id uuid;
  v_existing uuid;
  v_alloc jsonb;
  v_invoice_id uuid;
  v_amount numeric(20,0);
  v_allocated_total numeric(20,0) := 0;
  v_outstanding numeric(20,0);
  v_invoice public.invoices%rowtype;
begin
  perform public.assert_can_write(p_business_id);

  if p_amount_paise is null or p_amount_paise <= 0 then
    raise exception 'Payment amount must be greater than zero' using errcode = '22023';
  end if;
  if p_amount_paise <> round(p_amount_paise) then
    raise exception 'Payment amount must be a whole number of paise' using errcode = '22023';
  end if;
  if coalesce(trim(p_idempotency_key), '') = '' then
    raise exception 'An idempotency key is required' using errcode = '22023';
  end if;

  -- Idempotency: return the existing payment instead of creating a duplicate.
  select id into v_existing
  from public.payments
  where business_id = p_business_id and idempotency_key = p_idempotency_key;
  if v_existing is not null then
    return v_existing;
  end if;

  if not exists (
    select 1 from public.customers where id = p_customer_id and business_id = p_business_id
  ) then
    raise exception 'Customer not found in this business' using errcode = 'P0002';
  end if;

  insert into public.payments (
    business_id, customer_id, payment_date, amount_paise, payment_method,
    reference_number, cheque_status, notes, idempotency_key, created_by
  )
  values (
    p_business_id, p_customer_id, p_payment_date, p_amount_paise, p_payment_method,
    nullif(trim(coalesce(p_reference_number, '')), ''),
    case when p_payment_method = 'cheque' then coalesce(p_cheque_status, 'pending') else 'not_applicable' end,
    p_notes, p_idempotency_key, v_user_id
  )
  returning id into v_payment_id;

  if p_allocations is not null and jsonb_typeof(p_allocations) = 'array' then
    for v_alloc in select * from jsonb_array_elements(p_allocations)
    loop
      v_invoice_id := (v_alloc ->> 'invoice_id')::uuid;
      v_amount := (v_alloc ->> 'amount_paise')::numeric(20,0);

      if v_amount is null or v_amount <= 0 then
        raise exception 'Allocation amounts must be greater than zero' using errcode = '22023';
      end if;

      -- Lock the invoice row so concurrent payments cannot over-allocate it.
      select * into v_invoice
      from public.invoices
      where id = v_invoice_id and business_id = p_business_id
      for update;

      if not found then
        raise exception 'Invoice % not found in this business', v_invoice_id using errcode = 'P0002';
      end if;
      if v_invoice.customer_id <> p_customer_id then
        raise exception 'Invoice % belongs to a different customer', v_invoice.invoice_number
          using errcode = '22023';
      end if;
      if v_invoice.document_state <> 'issued' then
        raise exception 'Invoice % is not issued and cannot receive payments', v_invoice.invoice_number
          using errcode = '22023';
      end if;

      select greatest(v_invoice.total_amount_paise - coalesce(sum(pa.allocated_amount_paise), 0), 0)
      into v_outstanding
      from public.payment_allocations pa
      join public.payments p on p.id = pa.payment_id
      where pa.invoice_id = v_invoice_id and p.reversed_at is null;

      if v_amount > v_outstanding then
        raise exception 'Allocation of % exceeds the outstanding balance % of invoice %',
          v_amount, v_outstanding, v_invoice.invoice_number using errcode = '22023';
      end if;

      insert into public.payment_allocations (
        business_id, payment_id, invoice_id, allocated_amount_paise, created_by
      )
      values (p_business_id, v_payment_id, v_invoice_id, v_amount, v_user_id);

      v_allocated_total := v_allocated_total + v_amount;
    end loop;
  end if;

  if v_allocated_total > p_amount_paise then
    raise exception 'Allocations exceed the payment amount' using errcode = '22023';
  end if;

  perform public.write_audit_log(
    p_business_id, 'payment', v_payment_id, 'payment.recorded', null,
    jsonb_build_object(
      'amount_paise', p_amount_paise,
      'allocated_paise', v_allocated_total,
      'unallocated_paise', p_amount_paise - v_allocated_total,
      'payment_method', p_payment_method
    )
  );

  return v_payment_id;
end;
$$;

revoke all on function public.record_payment(uuid, uuid, date, numeric, public.payment_method, text, text, text, jsonb, public.cheque_status) from public;
grant execute on function public.record_payment(uuid, uuid, date, numeric, public.payment_method, text, text, text, jsonb, public.cheque_status) to authenticated;

-- ---------------------------------------------------------------------------
-- reverse_payment
--   Marks a payment reversed and removes its allocations. The original payment
--   row is preserved for audit; invoice balances are restored automatically
--   because the balance views ignore reversed payments.
-- ---------------------------------------------------------------------------
create or replace function public.reverse_payment(p_payment_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.payments%rowtype;
  v_allocated numeric(20,0);
begin
  select * into v_payment from public.payments where id = p_payment_id;
  if not found then
    raise exception 'Payment not found' using errcode = 'P0002';
  end if;

  perform public.assert_can_manage(v_payment.business_id);

  if v_payment.reversed_at is not null then
    raise exception 'Payment is already reversed' using errcode = '22023';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required to reverse a payment' using errcode = '22023';
  end if;

  select coalesce(sum(allocated_amount_paise), 0) into v_allocated
  from public.payment_allocations where payment_id = p_payment_id;

  delete from public.payment_allocations where payment_id = p_payment_id;

  update public.payments
  set reversed_at = now(), reversed_by = auth.uid(), reversal_reason = trim(p_reason)
  where id = p_payment_id;

  perform public.write_audit_log(
    v_payment.business_id, 'payment', p_payment_id, 'payment.reversed',
    jsonb_build_object('amount_paise', v_payment.amount_paise, 'allocated_paise', v_allocated),
    jsonb_build_object('reason', trim(p_reason))
  );
end;
$$;

revoke all on function public.reverse_payment(uuid, text) from public;
grant execute on function public.reverse_payment(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- log_reminder
--   Records that the user confirmed a reminder was sent. Opening a WhatsApp
--   link alone never calls this function.
-- ---------------------------------------------------------------------------
create or replace function public.log_reminder(
  p_business_id uuid,
  p_customer_id uuid,
  p_invoice_id uuid,
  p_channel text,
  p_message text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  perform public.assert_can_write(p_business_id);

  if not exists (
    select 1 from public.customers where id = p_customer_id and business_id = p_business_id
  ) then
    raise exception 'Customer not found in this business' using errcode = 'P0002';
  end if;

  insert into public.reminder_logs (business_id, customer_id, invoice_id, channel, message, created_by)
  values (p_business_id, p_customer_id, p_invoice_id, coalesce(p_channel, 'whatsapp'), p_message, auth.uid())
  returning id into v_id;

  perform public.write_audit_log(
    p_business_id, 'reminder', v_id, 'reminder.logged', null,
    jsonb_build_object('invoice_id', p_invoice_id, 'channel', p_channel)
  );

  return v_id;
end;
$$;

revoke all on function public.log_reminder(uuid, uuid, uuid, text, text) from public;
grant execute on function public.log_reminder(uuid, uuid, uuid, text, text) to authenticated;
