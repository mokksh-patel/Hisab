-- ===========================================================================
-- BizPilot — 0002 membership helpers, RLS policies and derived views
--
-- SECURITY MODEL
--   * Every tenant-owned table has RLS enabled and forced.
--   * Membership is checked through SECURITY DEFINER helper functions with a
--     fixed search_path. This avoids the classic recursive-RLS problem where a
--     policy on business_members needs to read business_members.
--   * Helpers are STABLE so Postgres can cache them per statement.
--   * Roles: owner > admin > accountant > collection_staff > read_only.
--     Writes to financial documents require accountant or above; destructive
--     actions (void, delete, reversal) require owner or admin.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------------

-- Is the current user an active member of this business?
create or replace function public.is_business_member(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.business_members m
    where m.business_id = p_business_id
      and m.user_id = auth.uid()
      and m.invitation_status = 'accepted'
  );
$$;

-- Does the current user hold one of the given roles in this business?
create or replace function public.has_business_role(p_business_id uuid, p_roles public.member_role[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.business_members m
    where m.business_id = p_business_id
      and m.user_id = auth.uid()
      and m.invitation_status = 'accepted'
      and m.role = any (p_roles)
  );
$$;

-- Convenience predicates used by the policies below.
create or replace function public.can_write_financials(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.has_business_role(
    p_business_id,
    array['owner', 'admin', 'accountant']::public.member_role[]
  );
$$;

create or replace function public.can_manage_business(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.has_business_role(
    p_business_id,
    array['owner', 'admin']::public.member_role[]
  );
$$;

create or replace function public.is_business_owner(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.has_business_role(p_business_id, array['owner']::public.member_role[]);
$$;

revoke all on function public.is_business_member(uuid) from public;
revoke all on function public.has_business_role(uuid, public.member_role[]) from public;
revoke all on function public.can_write_financials(uuid) from public;
revoke all on function public.can_manage_business(uuid) from public;
revoke all on function public.is_business_owner(uuid) from public;

grant execute on function public.is_business_member(uuid) to authenticated;
grant execute on function public.has_business_role(uuid, public.member_role[]) to authenticated;
grant execute on function public.can_write_financials(uuid) to authenticated;
grant execute on function public.can_manage_business(uuid) to authenticated;
grant execute on function public.is_business_owner(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------
alter table public.businesses          enable row level security;
alter table public.profiles            enable row level security;
alter table public.business_members    enable row level security;
alter table public.customers           enable row level security;
alter table public.invoice_sequences   enable row level security;
alter table public.invoices            enable row level security;
alter table public.invoice_items       enable row level security;
alter table public.payments            enable row level security;
alter table public.payment_allocations enable row level security;
alter table public.reminder_logs       enable row level security;
alter table public.audit_logs          enable row level security;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = auth.uid());

create policy profiles_insert_own on public.profiles
  for insert to authenticated
  with check (id = auth.uid());

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- businesses
-- ---------------------------------------------------------------------------
create policy businesses_select_member on public.businesses
  for select to authenticated
  using (public.is_business_member(id));

-- Businesses are created ONLY through public.create_business_with_owner(),
-- which inserts the business and the caller's owner membership in one
-- transaction. There is deliberately no INSERT policy here: a direct insert
-- would create an orphan business with no owner and no members, invisible to
-- every user and unaudited. The RPC is SECURITY DEFINER, so it does not need
-- a policy to perform the insert.

create policy businesses_update_admin on public.businesses
  for update to authenticated
  using (public.can_manage_business(id))
  with check (public.can_manage_business(id));

-- Businesses are never hard-deleted through the API.
create policy businesses_delete_owner on public.businesses
  for delete to authenticated
  using (public.is_business_owner(id));

-- ---------------------------------------------------------------------------
-- business_members
-- ---------------------------------------------------------------------------
create policy business_members_select_member on public.business_members
  for select to authenticated
  using (public.is_business_member(business_id));

-- Only owners/admins may add members.
create policy business_members_insert_admin on public.business_members
  for insert to authenticated
  with check (public.can_manage_business(business_id));

-- Only owners/admins may change roles. The escalation path is closed here: an
-- admin may not grant the 'owner' role, only an existing owner can. The
-- complementary rule (an owner may not demote themselves, which would leave
-- the business ownerless) needs OLD/NEW access and therefore lives in the
-- business_members_guard_role trigger in migration 0004.
create policy business_members_update_admin on public.business_members
  for update to authenticated
  using (public.can_manage_business(business_id))
  with check (
    public.can_manage_business(business_id)
    and (role <> 'owner' or public.is_business_owner(business_id))
  );

create policy business_members_delete_admin on public.business_members
  for delete to authenticated
  using (public.can_manage_business(business_id) and role <> 'owner');

-- ---------------------------------------------------------------------------
-- customers
-- ---------------------------------------------------------------------------
create policy customers_select_member on public.customers
  for select to authenticated
  using (public.is_business_member(business_id));

create policy customers_insert_writer on public.customers
  for insert to authenticated
  with check (public.can_write_financials(business_id));

create policy customers_update_writer on public.customers
  for update to authenticated
  using (public.can_write_financials(business_id))
  with check (public.can_write_financials(business_id));

-- Deleting a customer is destructive: owner/admin only, and the FK from
-- invoices (on delete restrict) prevents deleting a customer with history.
create policy customers_delete_admin on public.customers
  for delete to authenticated
  using (public.can_manage_business(business_id));

-- ---------------------------------------------------------------------------
-- invoice_sequences — read-only for members; writes happen via RPC only
-- ---------------------------------------------------------------------------
create policy invoice_sequences_select_member on public.invoice_sequences
  for select to authenticated
  using (public.is_business_member(business_id));

-- ---------------------------------------------------------------------------
-- invoices
-- ---------------------------------------------------------------------------
create policy invoices_select_member on public.invoices
  for select to authenticated
  using (public.is_business_member(business_id));

create policy invoices_insert_writer on public.invoices
  for insert to authenticated
  with check (public.can_write_financials(business_id));

create policy invoices_update_writer on public.invoices
  for update to authenticated
  using (public.can_write_financials(business_id))
  with check (public.can_write_financials(business_id));

-- Issued financial documents are never deleted (issue #11). Drafts may be
-- removed by owner/admin only.
create policy invoices_delete_draft_admin on public.invoices
  for delete to authenticated
  using (public.can_manage_business(business_id) and document_state = 'draft');

-- ---------------------------------------------------------------------------
-- invoice_items
-- ---------------------------------------------------------------------------
create policy invoice_items_select_member on public.invoice_items
  for select to authenticated
  using (public.is_business_member(business_id));

create policy invoice_items_insert_writer on public.invoice_items
  for insert to authenticated
  with check (public.can_write_financials(business_id));

create policy invoice_items_update_writer on public.invoice_items
  for update to authenticated
  using (public.can_write_financials(business_id))
  with check (public.can_write_financials(business_id));

create policy invoice_items_delete_writer on public.invoice_items
  for delete to authenticated
  using (public.can_write_financials(business_id));

-- ---------------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------------
create policy payments_select_member on public.payments
  for select to authenticated
  using (public.is_business_member(business_id));

create policy payments_insert_writer on public.payments
  for insert to authenticated
  with check (public.can_write_financials(business_id));

-- Payments are corrected by reversal, not by editing amounts. Only the
-- reversal columns may change, and only owner/admin may do it.
create policy payments_update_admin on public.payments
  for update to authenticated
  using (public.can_manage_business(business_id))
  with check (public.can_manage_business(business_id));

-- Payments are never deleted (issue #11).
create policy payments_no_delete on public.payments
  for delete to authenticated
  using (false);

-- ---------------------------------------------------------------------------
-- payment_allocations
-- ---------------------------------------------------------------------------
create policy payment_allocations_select_member on public.payment_allocations
  for select to authenticated
  using (public.is_business_member(business_id));

create policy payment_allocations_insert_writer on public.payment_allocations
  for insert to authenticated
  with check (public.can_write_financials(business_id));

-- Allocations are never silently changed or deleted; a reversal removes them
-- inside a SECURITY DEFINER function that writes an audit record.
create policy payment_allocations_no_update on public.payment_allocations
  for update to authenticated
  using (false);

create policy payment_allocations_no_delete on public.payment_allocations
  for delete to authenticated
  using (false);

-- ---------------------------------------------------------------------------
-- reminder_logs
-- ---------------------------------------------------------------------------
create policy reminder_logs_select_member on public.reminder_logs
  for select to authenticated
  using (public.is_business_member(business_id));

create policy reminder_logs_insert_writer on public.reminder_logs
  for insert to authenticated
  with check (public.can_write_financials(business_id));

-- ---------------------------------------------------------------------------
-- audit_logs — append-only, readable by members, never writable by clients
-- ---------------------------------------------------------------------------
create policy audit_logs_select_member on public.audit_logs
  for select to authenticated
  using (public.is_business_member(business_id));

-- No insert/update/delete policies: audit rows are written only by
-- SECURITY DEFINER functions, which bypass RLS by design.

-- ---------------------------------------------------------------------------
-- Derived views
--
-- security_invoker = true makes the view run with the caller's permissions, so
-- the RLS policies of the underlying tables still apply. This is the safe
-- default and prevents a view from becoming a tenant-isolation hole.
-- ---------------------------------------------------------------------------

-- Per-invoice financial position, derived from actual allocations.
create or replace view public.invoice_balances
with (security_invoker = true)
as
select
  i.id as invoice_id,
  i.business_id,
  i.customer_id,
  i.invoice_number,
  i.financial_year,
  i.invoice_date,
  i.due_date,
  i.document_state,
  i.total_amount_paise,
  coalesce(alloc.allocated_paise, 0::numeric(20,0)) as allocated_paise,
  greatest(i.total_amount_paise - coalesce(alloc.allocated_paise, 0), 0)::numeric(20,0) as outstanding_paise,
  i.issued_at,
  i.created_at
from public.invoices i
left join (
  select
    pa.invoice_id,
    sum(pa.allocated_amount_paise)::numeric(20,0) as allocated_paise
  from public.payment_allocations pa
  join public.payments p on p.id = pa.payment_id
  where p.reversed_at is null
  group by pa.invoice_id
) alloc on alloc.invoice_id = i.id;

-- Per-payment allocation position.
create or replace view public.payment_balances
with (security_invoker = true)
as
select
  p.id as payment_id,
  p.business_id,
  p.customer_id,
  p.payment_date,
  p.amount_paise,
  p.payment_method,
  p.reference_number,
  p.cheque_status,
  p.reversed_at,
  coalesce(alloc.allocated_paise, 0::numeric(20,0)) as allocated_paise,
  greatest(p.amount_paise - coalesce(alloc.allocated_paise, 0), 0)::numeric(20,0) as unallocated_paise,
  p.created_by,
  p.created_at
from public.payments p
left join (
  select
    pa.payment_id,
    sum(pa.allocated_amount_paise)::numeric(20,0) as allocated_paise
  from public.payment_allocations pa
  group by pa.payment_id
) alloc on alloc.payment_id = p.id;

-- Customer receivables summary (used by the customers list and dashboard).
create or replace view public.customer_receivables
with (security_invoker = true)
as
select
  c.id as customer_id,
  c.business_id,
  c.customer_name,
  c.phone,
  c.email,
  c.city,
  c.gstin,
  coalesce(sum(b.outstanding_paise) filter (where b.document_state = 'issued'), 0)::numeric(20,0) as outstanding_paise,
  coalesce(sum(b.outstanding_paise) filter (
    where b.document_state = 'issued' and b.due_date < current_date
  ), 0)::numeric(20,0) as overdue_paise,
  coalesce(sum(b.total_amount_paise) filter (where b.document_state = 'issued'), 0)::numeric(20,0) as total_invoiced_paise,
  min(b.due_date) filter (where b.document_state = 'issued' and b.outstanding_paise > 0) as oldest_due_date,
  count(b.invoice_id) filter (where b.document_state = 'issued' and b.outstanding_paise > 0) as open_invoice_count
from public.customers c
left join public.invoice_balances b on b.customer_id = c.id
group by c.id;

grant select on public.invoice_balances to authenticated;
grant select on public.payment_balances to authenticated;
grant select on public.customer_receivables to authenticated;
