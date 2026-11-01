/**
 * paymentService.ts — recording, allocating and reversing payments.
 *
 * A payment and its allocations are written by a single database function so
 * they can never be half-applied. The idempotency key prevents duplicates when
 * a user double-submits the form.
 */

import { supabase } from '@/lib/supabase';
import { unwrap } from '@/lib/errors';
import type {
  Payment,
  PaymentAllocation,
  PaymentBalance,
  PaymentMethod,
  RecordPaymentAllocationPayload,
} from '@/types/database';

export interface RecordPaymentInput {
  businessId: string;
  customerId: string;
  paymentDate: string;
  amountPaise: bigint;
  paymentMethod: PaymentMethod;
  referenceNumber?: string | null;
  notes?: string | null;
  allocations: RecordPaymentAllocationPayload[];
  idempotencyKey?: string;
}

/**
 * Generate a client-side idempotency key. Uses `crypto.randomUUID` when
 * available and falls back to a timestamp + random suffix.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `pay-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function recordPayment(input: RecordPaymentInput): Promise<string> {
  const data = unwrap(
    await supabase.rpc('record_payment', {
      p_business_id: input.businessId,
      p_customer_id: input.customerId,
      p_payment_date: input.paymentDate,
      p_amount_paise: input.amountPaise.toString(),
      p_payment_method: input.paymentMethod,
      p_reference_number: input.referenceNumber ?? null,
      p_idempotency_key: input.idempotencyKey ?? newIdempotencyKey(),
      p_notes: input.notes ?? null,
      p_allocations: input.allocations,
    }),
  );
  return data as string;
}

export async function reversePayment(paymentId: string, reason: string): Promise<void> {
  unwrap(await supabase.rpc('reverse_payment', { p_payment_id: paymentId, p_reason: reason }));
}

export async function getPayment(paymentId: string): Promise<Payment> {
  return unwrap(
    await supabase.from('payments').select('*').eq('id', paymentId).single(),
  ) as Payment;
}

export async function listPayments(
  businessId: string,
  options: { customerId?: string; limit?: number; offset?: number } = {},
): Promise<PaymentBalance[]> {
  const limit = options.limit ?? 25;
  const offset = options.offset ?? 0;

  let query = supabase
    .from('payment_balances')
    .select('*')
    .eq('business_id', businessId)
    .order('payment_date', { ascending: false })
    .range(offset, offset + limit - 1);

  if (options.customerId) query = query.eq('customer_id', options.customerId);

  return unwrap(await query) as PaymentBalance[];
}

export interface AllocationWithInvoice extends PaymentAllocation {
  invoice_number: string;
}

export async function listAllocationsForPayment(paymentId: string): Promise<AllocationWithInvoice[]> {
  const rows = unwrap(
    await supabase
      .from('payment_allocations')
      .select('*, invoices!inner(invoice_number)')
      .eq('payment_id', paymentId),
  ) as (PaymentAllocation & { invoices: { invoice_number: string } })[];

  return rows.map(({ invoices, ...rest }) => ({
    ...rest,
    invoice_number: invoices?.invoice_number ?? '—',
  }));
}
