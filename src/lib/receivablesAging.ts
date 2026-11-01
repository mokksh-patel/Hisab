/**
 * receivablesAging.ts — aging buckets and derived invoice status.
 *
 * RULES:
 *  1. Buckets are mutually exclusive and cover every possible day count.
 *  2. Aging uses the UNPAID BALANCE, never the original invoice total.
 *  3. An invoice due today is NOT overdue (days past due = 0 -> "current").
 *  4. Aging is computed against an explicit as-of date so historical reports
 *     can be reproduced exactly.
 */

import type { Paise } from './money';
import { daysPastDue, type IsoDate } from './dateUtils';

export type AgingBucket = 'current' | 'days_1_30' | 'days_31_60' | 'days_61_90' | 'days_91_plus';

export const AGING_BUCKETS: readonly AgingBucket[] = [
  'current',
  'days_1_30',
  'days_31_60',
  'days_61_90',
  'days_91_plus',
] as const;

export const AGING_BUCKET_LABELS: Record<AgingBucket, string> = {
  current: 'Current',
  days_1_30: '1–30 days',
  days_31_60: '31–60 days',
  days_61_90: '61–90 days',
  days_91_plus: '91+ days',
};

/**
 * Map days past due to a bucket.
 *   <= 0        -> current   (not yet due, or due today)
 *   1..30       -> days_1_30
 *   31..60      -> days_31_60
 *   61..90      -> days_61_90
 *   >= 91       -> days_91_plus
 */
export function agingBucketFor(daysPastDueCount: number): AgingBucket {
  if (daysPastDueCount <= 0) return 'current';
  if (daysPastDueCount <= 30) return 'days_1_30';
  if (daysPastDueCount <= 60) return 'days_31_60';
  if (daysPastDueCount <= 90) return 'days_61_90';
  return 'days_91_plus';
}

/** Bucket for an invoice given its due date and the as-of date. */
export function bucketForDueDate(dueDate: IsoDate, asOf: IsoDate): AgingBucket {
  return agingBucketFor(daysPastDue(dueDate, asOf));
}

export interface AgingInput {
  dueDate: IsoDate;
  outstandingPaise: Paise;
}

export interface AgingBucketSummary {
  bucket: AgingBucket;
  label: string;
  amountPaise: Paise;
  invoiceCount: number;
}

export interface AgingReport {
  asOf: IsoDate;
  buckets: AgingBucketSummary[];
  totalOutstandingPaise: Paise;
  totalOverduePaise: Paise;
  totalInvoiceCount: number;
}

/**
 * Build an aging report. Invoices with a zero balance are ignored — a paid
 * invoice is never "aged".
 */
export function buildAgingReport(invoices: readonly AgingInput[], asOf: IsoDate): AgingReport {
  const totals = new Map<AgingBucket, { amount: Paise; count: number }>(
    AGING_BUCKETS.map((bucket) => [bucket, { amount: 0n, count: 0 }]),
  );

  let totalOutstandingPaise = 0n;
  let totalOverduePaise = 0n;
  let totalInvoiceCount = 0;

  for (const invoice of invoices) {
    if (invoice.outstandingPaise <= 0n) continue;
    const bucket = bucketForDueDate(invoice.dueDate, asOf);
    const entry = totals.get(bucket)!;
    entry.amount += invoice.outstandingPaise;
    entry.count += 1;

    totalOutstandingPaise += invoice.outstandingPaise;
    totalInvoiceCount += 1;
    if (bucket !== 'current') {
      totalOverduePaise += invoice.outstandingPaise;
    }
  }

  return {
    asOf,
    buckets: AGING_BUCKETS.map((bucket) => ({
      bucket,
      label: AGING_BUCKET_LABELS[bucket],
      amountPaise: totals.get(bucket)!.amount,
      invoiceCount: totals.get(bucket)!.count,
    })),
    totalOutstandingPaise,
    totalOverduePaise,
    totalInvoiceCount,
  };
}

/**
 * Derived invoice status. Document lifecycle (draft/issued/void) is stored;
 * payment and overdue status are always derived from allocations + due date.
 */
export type DerivedInvoiceStatus =
  | 'draft'
  | 'void'
  | 'paid'
  | 'partially_paid'
  | 'overdue'
  | 'due_today'
  | 'current';

export interface DerivedStatusInput {
  documentState: 'draft' | 'issued' | 'void';
  totalAmountPaise: Paise;
  outstandingPaise: Paise;
  dueDate: IsoDate;
  asOf: IsoDate;
}

export function deriveInvoiceStatus(input: DerivedStatusInput): DerivedInvoiceStatus {
  if (input.documentState === 'draft') return 'draft';
  if (input.documentState === 'void') return 'void';
  if (input.outstandingPaise <= 0n) return 'paid';

  const overdueDays = daysPastDue(input.dueDate, input.asOf);
  if (overdueDays > 0) return 'overdue';
  if (overdueDays === 0) return 'due_today';
  return input.outstandingPaise < input.totalAmountPaise ? 'partially_paid' : 'current';
}

export const DERIVED_STATUS_LABELS: Record<DerivedInvoiceStatus, string> = {
  draft: 'Draft',
  void: 'Void',
  paid: 'Paid',
  partially_paid: 'Partially paid',
  overdue: 'Overdue',
  due_today: 'Due today',
  current: 'Current',
};
