-- ===========================================================================
-- Financial lifecycle verification
--
-- Exercises every receivables state against the REAL database and asserts the
-- derived figures. Runs inside a transaction and rolls back, so it leaves no
-- data behind.
--
-- Run with: npx supabase db query --linked --file scripts/verify-financial.sql
-- ===========================================================================

begin;

-- Synthetic business + owner.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous,
  confirmation_token, recovery_token, email_change, email_change_token_new,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token
) values (
  '00000000-0000-0000-0000-000000000000', 'f0000000-0000-0000-0000-000000000001',
  'authenticated', 'authenticated', 'fin-verify@example.com', 'x',
  now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false, false,
  '', '', '', '', '', '', '', ''
);

insert into public.businesses (id, legal_name, display_name, state_code, invoice_prefix)
values ('f0000000-0000-0000-0000-00000000000b', 'Fin Verify Pvt Ltd', 'Fin Verify', '24', 'FV');

insert into public.business_members (business_id, user_id, role, invitation_status)
values ('f0000000-0000-0000-0000-00000000000b', 'f0000000-0000-0000-0000-000000000001', 'owner', 'accepted');

insert into public.customers (id, business_id, customer_name, state_code)
values ('f0000000-0000-0000-0000-00000000000c', 'f0000000-0000-0000-0000-00000000000b', 'Fin Customer', '24');

-- ---------------------------------------------------------------------------
-- Scenario 1: unpaid invoice. 10 x 50000 paise + 18% GST = 590000 paise.
-- ---------------------------------------------------------------------------
insert into public.invoices (
  id, business_id, customer_id, invoice_number, financial_year, invoice_date,
  due_date, document_state, gst_mode, subtotal_paise, taxable_amount_paise,
  cgst_paise, sgst_paise, total_tax_paise, total_amount_paise, issued_at
) values (
  'f0000000-0000-0000-0000-0000000000a1', 'f0000000-0000-0000-0000-00000000000b',
  'f0000000-0000-0000-0000-00000000000c', 'FV-001', '2026-27', '2026-10-01',
  '2026-10-31', 'issued', 'intra_state', 500000, 500000,
  45000, 45000, 90000, 590000, now()
);

-- ---------------------------------------------------------------------------
-- Scenario 2: partially paid invoice (200000 of 590000).
-- ---------------------------------------------------------------------------
insert into public.payments (id, business_id, customer_id, payment_date, amount_paise, payment_method, idempotency_key)
values ('f0000000-0000-0000-0000-0000000000e1', 'f0000000-0000-0000-0000-00000000000b',
        'f0000000-0000-0000-0000-00000000000c', '2026-10-15', 200000, 'upi', 'fin-key-1');

insert into public.payment_allocations (business_id, payment_id, invoice_id, allocated_amount_paise)
values ('f0000000-0000-0000-0000-00000000000b', 'f0000000-0000-0000-0000-0000000000e1',
        'f0000000-0000-0000-0000-0000000000a1', 200000);

-- ---------------------------------------------------------------------------
-- Scenario 3: fully paid invoice (second payment clears the remainder).
-- ---------------------------------------------------------------------------
insert into public.payments (id, business_id, customer_id, payment_date, amount_paise, payment_method, idempotency_key)
values ('f0000000-0000-0000-0000-0000000000e2', 'f0000000-0000-0000-0000-00000000000b',
        'f0000000-0000-0000-0000-00000000000c', '2026-10-20', 390000, 'cash', 'fin-key-2');

insert into public.payment_allocations (business_id, payment_id, invoice_id, allocated_amount_paise)
values ('f0000000-0000-0000-0000-00000000000b', 'f0000000-0000-0000-0000-0000000000e2',
        'f0000000-0000-0000-0000-0000000000a1', 390000);

-- ---------------------------------------------------------------------------
-- Scenario 4: unallocated advance (payment with no allocation).
-- ---------------------------------------------------------------------------
insert into public.payments (id, business_id, customer_id, payment_date, amount_paise, payment_method, idempotency_key)
values ('f0000000-0000-0000-0000-0000000000e3', 'f0000000-0000-0000-0000-00000000000b',
        'f0000000-0000-0000-0000-00000000000c', '2026-10-21', 100000, 'cash', 'fin-key-3');

-- ---------------------------------------------------------------------------
-- Scenario 5: reversed payment. A 50000 payment allocated then reversed must
-- restore the invoice balance.
-- ---------------------------------------------------------------------------
insert into public.invoices (
  id, business_id, customer_id, invoice_number, financial_year, invoice_date,
  due_date, document_state, gst_mode, subtotal_paise, taxable_amount_paise,
  total_tax_paise, total_amount_paise, issued_at
) values (
  'f0000000-0000-0000-0000-0000000000a2', 'f0000000-0000-0000-0000-00000000000b',
  'f0000000-0000-0000-0000-00000000000c', 'FV-002', '2026-27', '2026-10-02',
  '2026-11-01', 'issued', 'intra_state', 100000, 100000, 0, 100000, now()
);

insert into public.payments (id, business_id, customer_id, payment_date, amount_paise, payment_method, idempotency_key, reversed_at, reversal_reason)
values ('f0000000-0000-0000-0000-0000000000e4', 'f0000000-0000-0000-0000-00000000000b',
        'f0000000-0000-0000-0000-00000000000c', '2026-10-22', 50000, 'upi', 'fin-key-4', now(), 'test reversal');

insert into public.payment_allocations (business_id, payment_id, invoice_id, allocated_amount_paise)
values ('f0000000-0000-0000-0000-00000000000b', 'f0000000-0000-0000-0000-0000000000e4',
        'f0000000-0000-0000-0000-0000000000a2', 50000);

-- ---------------------------------------------------------------------------
-- Scenario 6: voided invoice — must not count toward receivables.
-- ---------------------------------------------------------------------------
insert into public.invoices (
  id, business_id, customer_id, invoice_number, financial_year, invoice_date,
  due_date, document_state, gst_mode, subtotal_paise, taxable_amount_paise,
  total_tax_paise, total_amount_paise, issued_at, voided_at, void_reason
) values (
  'f0000000-0000-0000-0000-0000000000a3', 'f0000000-0000-0000-0000-00000000000b',
  'f0000000-0000-0000-0000-00000000000c', 'FV-003', '2026-27', '2026-10-03',
  '2026-11-02', 'void', 'intra_state', 700000, 700000, 0, 700000, now(), now(), 'raised in error'
);

-- ---------------------------------------------------------------------------
-- Scenario 7: overdue invoice (due date in the past).
-- ---------------------------------------------------------------------------
insert into public.invoices (
  id, business_id, customer_id, invoice_number, financial_year, invoice_date,
  due_date, document_state, gst_mode, subtotal_paise, taxable_amount_paise,
  total_tax_paise, total_amount_paise, issued_at
) values (
  'f0000000-0000-0000-0000-0000000000a4', 'f0000000-0000-0000-0000-00000000000b',
  'f0000000-0000-0000-0000-00000000000c', 'FV-004', '2026-27', '2026-01-01',
  '2026-01-31', 'issued', 'intra_state', 300000, 300000, 0, 300000, now()
);

-- ===========================================================================
-- Assertions
-- ===========================================================================
select
  -- FV-001 fully paid: outstanding must be 0.
  (select outstanding_paise from public.invoice_balances where invoice_number = 'FV-001') as fv001_outstanding,
  (select allocated_paise   from public.invoice_balances where invoice_number = 'FV-001') as fv001_allocated,

  -- FV-002: reversed payment must NOT count, so outstanding = full 100000.
  (select outstanding_paise from public.invoice_balances where invoice_number = 'FV-002') as fv002_outstanding,

  -- FV-003 voided: excluded from receivables.
  (select count(*) from public.invoice_balances
    where invoice_number = 'FV-003' and document_state = 'issued') as fv003_issued_rows,

  -- FV-004 overdue: full 300000 outstanding.
  (select outstanding_paise from public.invoice_balances where invoice_number = 'FV-004') as fv004_outstanding,

  -- Unallocated advance: 100000 received, 0 allocated.
  (select unallocated_paise from public.payment_balances
    where payment_id = 'f0000000-0000-0000-0000-0000000000e3') as advance_unallocated,

  -- Customer receivables: only issued invoices with a balance.
  -- FV-001 = 0, FV-002 = 100000, FV-004 = 300000 => 400000.
  (select outstanding_paise from public.customer_receivables
    where customer_id = 'f0000000-0000-0000-0000-00000000000c') as customer_outstanding,

  -- Overdue: FV-004 (due 2026-01-31) is overdue; FV-002 (due 2026-11-01) is not.
  (select overdue_paise from public.customer_receivables
    where customer_id = 'f0000000-0000-0000-0000-00000000000c') as customer_overdue;

rollback;
