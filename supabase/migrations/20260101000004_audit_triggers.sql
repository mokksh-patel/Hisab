-- ===========================================================================
-- BizPilot — 0004 audit triggers and immutability guards
--
-- Two layers of financial safety:
--   1. TRIGGERS write audit rows for direct table changes (customer edits,
--      settings changes) that do not go through an RPC.
--   2. GUARDS reject updates that would rewrite financial history:
--        * issued invoices cannot change their totals, customer or dates
--        * payments cannot change their amount, customer or date
--        * audit_logs are append-only
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Guard: issued invoices are financially frozen.
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
       or new.invoice_number <> old.invoice_number then
      raise exception 'An issued invoice cannot be modified. Void it and issue a corrected invoice instead.'
        using errcode = '22023';
    end if;
  end if;

  if old.document_state = 'void' and new.document_state <> 'void' then
    raise exception 'A void invoice cannot be reinstated' using errcode = '22023';
  end if;

  -- An issued invoice may only move forward to 'void'. Reverting it to 'draft'
  -- would unfreeze its line items (guard_invoice_item_change only protects
  -- non-draft invoices) and let the financial history be rewritten.
  if old.document_state = 'issued' and new.document_state = 'draft' then
    raise exception 'An issued invoice cannot be returned to draft. Void it and issue a corrected invoice instead.'
      using errcode = '22023';
  end if;

  return new;
end;
$$;

create trigger invoices_guard_update
  before update on public.invoices
  for each row execute function public.guard_invoice_update();

-- ---------------------------------------------------------------------------
-- Guard: invoice items of a non-draft invoice are immutable.
-- ---------------------------------------------------------------------------
create or replace function public.guard_invoice_item_change()
returns trigger
language plpgsql
as $$
declare
  v_state public.document_state;
begin
  select document_state into v_state
  from public.invoices
  where id = coalesce(new.invoice_id, old.invoice_id);

  if v_state is not null and v_state <> 'draft' then
    raise exception 'Line items of an issued invoice cannot be changed' using errcode = '22023';
  end if;

  return coalesce(new, old);
end;
$$;

create trigger invoice_items_guard_change
  before insert or update or delete on public.invoice_items
  for each row execute function public.guard_invoice_item_change();

-- ---------------------------------------------------------------------------
-- Guard: payments are immutable except for the reversal columns.
-- ---------------------------------------------------------------------------
create or replace function public.guard_payment_update()
returns trigger
language plpgsql
as $$
begin
  if new.amount_paise <> old.amount_paise
     or new.customer_id <> old.customer_id
     or new.payment_date <> old.payment_date
     or new.payment_method <> old.payment_method
     or new.idempotency_key <> old.idempotency_key then
    raise exception 'A recorded payment cannot be edited. Reverse it and record a corrected payment.'
      using errcode = '22023';
  end if;

  if old.reversed_at is not null and new.reversed_at is null then
    raise exception 'A reversed payment cannot be un-reversed' using errcode = '22023';
  end if;

  return new;
end;
$$;

create trigger payments_guard_update
  before update on public.payments
  for each row execute function public.guard_payment_update();

-- ---------------------------------------------------------------------------
-- Guard: audit_logs are append-only.
-- ---------------------------------------------------------------------------
create or replace function public.guard_audit_log_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Audit history is append-only and cannot be modified or deleted'
    using errcode = '22023';
end;
$$;

create trigger audit_logs_guard_update
  before update or delete on public.audit_logs
  for each row execute function public.guard_audit_log_immutable();

-- ---------------------------------------------------------------------------
-- Audit trigger: customers
-- ---------------------------------------------------------------------------
create or replace function public.audit_customer_changes()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    perform public.write_audit_log(
      new.business_id, 'customer', new.id, 'customer.created', null,
      jsonb_build_object('customer_name', new.customer_name, 'phone', new.phone)
    );
    return new;
  elsif tg_op = 'UPDATE' then
    perform public.write_audit_log(
      new.business_id, 'customer', new.id, 'customer.updated',
      jsonb_build_object(
        'customer_name', old.customer_name, 'phone', old.phone, 'email', old.email,
        'gstin', old.gstin, 'credit_period_days', old.credit_period_days
      ),
      jsonb_build_object(
        'customer_name', new.customer_name, 'phone', new.phone, 'email', new.email,
        'gstin', new.gstin, 'credit_period_days', new.credit_period_days
      )
    );
    return new;
  else
    perform public.write_audit_log(
      old.business_id, 'customer', old.id, 'customer.deleted',
      jsonb_build_object('customer_name', old.customer_name), null
    );
    return old;
  end if;
end;
$$;

create trigger customers_audit
  after insert or update or delete on public.customers
  for each row execute function public.audit_customer_changes();

-- ---------------------------------------------------------------------------
-- Audit trigger: business settings
-- ---------------------------------------------------------------------------
create or replace function public.audit_business_changes()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.write_audit_log(
    new.id, 'business', new.id, 'business.updated',
    jsonb_build_object(
      'legal_name', old.legal_name, 'display_name', old.display_name, 'gstin', old.gstin,
      'invoice_prefix', old.invoice_prefix, 'default_credit_period_days', old.default_credit_period_days
    ),
    jsonb_build_object(
      'legal_name', new.legal_name, 'display_name', new.display_name, 'gstin', new.gstin,
      'invoice_prefix', new.invoice_prefix, 'default_credit_period_days', new.default_credit_period_days
    )
  );
  return new;
end;
$$;

create trigger businesses_audit
  after update on public.businesses
  for each row execute function public.audit_business_changes();

-- ---------------------------------------------------------------------------
-- Audit trigger: membership changes
-- ---------------------------------------------------------------------------
create or replace function public.audit_member_changes()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    perform public.write_audit_log(
      new.business_id, 'business_member', new.id, 'member.invited', null,
      jsonb_build_object('user_id', new.user_id, 'role', new.role)
    );
    return new;
  elsif tg_op = 'UPDATE' then
    perform public.write_audit_log(
      new.business_id, 'business_member', new.id, 'member.role_changed',
      jsonb_build_object('role', old.role, 'invitation_status', old.invitation_status),
      jsonb_build_object('role', new.role, 'invitation_status', new.invitation_status)
    );
    return new;
  else
    perform public.write_audit_log(
      old.business_id, 'business_member', old.id, 'member.removed',
      jsonb_build_object('user_id', old.user_id, 'role', old.role), null
    );
    return old;
  end if;
end;
$$;

create trigger business_members_audit
  after insert or update or delete on public.business_members
  for each row execute function public.audit_member_changes();

-- ---------------------------------------------------------------------------
-- Guard: a business must always keep at least one owner.
--   The RLS policy on business_members already stops an admin from granting
--   the 'owner' role. This trigger covers the complementary case, which needs
--   OLD/NEW access: an owner demoting or removing themselves (or the last
--   remaining owner) would leave the business ownerless and unmanageable.
-- ---------------------------------------------------------------------------
create or replace function public.guard_last_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_other_owners integer;
begin
  -- Only relevant when an owner row stops being an accepted owner.
  if old.role <> 'owner' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE'
     and new.role = 'owner'
     and new.invitation_status = 'accepted' then
    return new;
  end if;

  select count(*) into v_other_owners
  from public.business_members m
  where m.business_id = old.business_id
    and m.id <> old.id
    and m.role = 'owner'
    and m.invitation_status = 'accepted';

  if v_other_owners = 0 then
    raise exception 'A business must keep at least one owner. Promote another member to owner first.'
      using errcode = '22023';
  end if;

  return coalesce(new, old);
end;
$$;

create trigger business_members_guard_last_owner
  before update or delete on public.business_members
  for each row execute function public.guard_last_owner();

-- ---------------------------------------------------------------------------
-- Profile bootstrap: create a profile row when a user signs up.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, full_name, phone)
  values (
    new.id,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''),
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'phone', '')), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
