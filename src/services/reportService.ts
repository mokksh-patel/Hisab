/**
 * reportService.ts — dashboard and receivables reporting.
 *
 * Aggregations run in the database (views + SQL functions) so the browser never
 * downloads thousands of invoices to compute one number.
 */

import { supabase } from '@/lib/supabase';
import { unwrap } from '@/lib/errors';
import { parsePaise, type Paise } from '@/lib/money';
import { buildAgingReport, type AgingReport } from '@/lib/receivablesAging';
import type { InvoiceBalance } from '@/types/database';

export interface DashboardSummary {
  totalOutstandingPaise: Paise;
  overduePaise: Paise;
  overdueCustomerCount: number;
  collectedThisMonthPaise: Paise;
  dueWithin7DaysPaise: Paise;
  openInvoiceCount: number;
}

/**
 * Dashboard KPIs.
 *
 * Outstanding and overdue come from the `invoice_balances` view; collections
 * come from `payment_balances`. Both are filtered by business_id, so RLS and
 * the explicit filter agree.
 */
export async function getDashboardSummary(
  businessId: string,
  today: string,
): Promise<DashboardSummary> {
  const invoices = unwrap(
    await supabase
      .from('invoice_balances')
      .select('customer_id, due_date, outstanding_paise, document_state')
      .eq('business_id', businessId)
      .eq('document_state', 'issued')
      .gt('outstanding_paise', 0),
  ) as Pick<InvoiceBalance, 'customer_id' | 'due_date' | 'outstanding_paise' | 'document_state'>[];

  const monthStart = `${today.slice(0, 7)}-01`;
  const payments = unwrap(
    await supabase
      .from('payment_balances')
      .select('amount_paise, payment_date, reversed_at')
      .eq('business_id', businessId)
      .gte('payment_date', monthStart)
      .lte('payment_date', today)
      .is('reversed_at', null),
  ) as { amount_paise: string; payment_date: string; reversed_at: string | null }[];

  let totalOutstandingPaise = 0n;
  let overduePaise = 0n;
  let dueWithin7DaysPaise = 0n;
  const overdueCustomers = new Set<string>();

  const sevenDaysAhead = addDaysIso(today, 7);

  for (const invoice of invoices) {
    const outstanding = parsePaise(invoice.outstanding_paise);
    totalOutstandingPaise += outstanding;

    if (invoice.due_date < today) {
      overduePaise += outstanding;
      overdueCustomers.add(invoice.customer_id);
    } else if (invoice.due_date <= sevenDaysAhead) {
      dueWithin7DaysPaise += outstanding;
    }
  }

  const collectedThisMonthPaise = payments.reduce(
    (sum, payment) => sum + parsePaise(payment.amount_paise),
    0n,
  );

  return {
    totalOutstandingPaise,
    overduePaise,
    overdueCustomerCount: overdueCustomers.size,
    collectedThisMonthPaise,
    dueWithin7DaysPaise,
    openInvoiceCount: invoices.length,
  };
}

/** Aging report built from live invoice balances. */
export async function getAgingReport(businessId: string, asOf: string): Promise<AgingReport> {
  const invoices = unwrap(
    await supabase
      .from('invoice_balances')
      .select('due_date, outstanding_paise')
      .eq('business_id', businessId)
      .eq('document_state', 'issued')
      .gt('outstanding_paise', 0),
  ) as Pick<InvoiceBalance, 'due_date' | 'outstanding_paise'>[];

  return buildAgingReport(
    invoices.map((invoice) => ({
      dueDate: invoice.due_date,
      outstandingPaise: parsePaise(invoice.outstanding_paise),
    })),
    asOf,
  );
}

export interface FollowUpRow {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  dueDate: string;
  outstandingPaise: Paise;
  daysOverdue: number;
}

/** The most overdue invoices, for the "Follow up today" panel. */
export async function getFollowUpList(
  businessId: string,
  today: string,
  limit = 5,
): Promise<FollowUpRow[]> {
  const rows = unwrap(
    await supabase
      .from('invoice_balances')
      .select('invoice_id, invoice_number, customer_id, due_date, outstanding_paise, customers!inner(customer_name, phone)')
      .eq('business_id', businessId)
      .eq('document_state', 'issued')
      .gt('outstanding_paise', 0)
      .lt('due_date', today)
      .order('due_date', { ascending: true })
      .limit(limit),
  ) as unknown as (Pick<InvoiceBalance, 'invoice_id' | 'invoice_number' | 'customer_id' | 'due_date' | 'outstanding_paise'> & {
    customers: { customer_name: string; phone: string | null };
  })[];

  return rows.map((row) => ({
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    customerId: row.customer_id,
    customerName: row.customers?.customer_name ?? 'Unknown customer',
    customerPhone: row.customers?.phone ?? null,
    dueDate: row.due_date,
    outstandingPaise: parsePaise(row.outstanding_paise),
    daysOverdue: daysBetweenIso(row.due_date, today),
  }));
}

/** Monthly collection totals for the last N months. */
export async function getCollectionTrend(
  businessId: string,
  months = 6,
  today: string,
): Promise<{ month: string; amountPaise: Paise }[]> {
  const start = addDaysIso(`${today.slice(0, 7)}-01`, -31 * (months - 1));
  const payments = unwrap(
    await supabase
      .from('payment_balances')
      .select('amount_paise, payment_date')
      .eq('business_id', businessId)
      .gte('payment_date', start)
      .lte('payment_date', today)
      .is('reversed_at', null),
  ) as { amount_paise: string; payment_date: string }[];

  const byMonth = new Map<string, Paise>();
  for (const payment of payments) {
    const key = payment.payment_date.slice(0, 7);
    byMonth.set(key, (byMonth.get(key) ?? 0n) + parsePaise(payment.amount_paise));
  }

  const result: { month: string; amountPaise: Paise }[] = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const key = addDaysIso(`${today.slice(0, 7)}-01`, -31 * i).slice(0, 7);
    result.push({ month: key, amountPaise: byMonth.get(key) ?? 0n });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Small local date helpers (kept here to avoid a circular import with lib)
// ---------------------------------------------------------------------------
function addDaysIso(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  probe.setUTCDate(probe.getUTCDate() + days);
  return probe.toISOString().slice(0, 10);
}

function daysBetweenIso(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  const a = Date.UTC(fy, fm - 1, fd);
  const b = Date.UTC(ty, tm - 1, td);
  return Math.round((b - a) / 86_400_000);
}
