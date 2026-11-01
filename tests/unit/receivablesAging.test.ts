import { describe, expect, it } from 'vitest';
import {
  AGING_BUCKETS,
  agingBucketFor,
  bucketForDueDate,
  buildAgingReport,
  deriveInvoiceStatus,
} from '@/lib/receivablesAging';

describe('agingBucketFor — boundary cases (acceptance test 7)', () => {
  it.each([
    [-30, 'current'],
    [-1, 'current'],
    [0, 'current'], // due today is NOT overdue
    [1, 'days_1_30'],
    [30, 'days_1_30'],
    [31, 'days_31_60'],
    [60, 'days_31_60'],
    [61, 'days_61_90'],
    [90, 'days_61_90'],
    [91, 'days_91_plus'],
    [365, 'days_91_plus'],
  ] as const)('day %i -> %s', (days, bucket) => {
    expect(agingBucketFor(days)).toBe(bucket);
  });
});

describe('bucketForDueDate', () => {
  it('maps due dates against an as-of date', () => {
    const asOf = '2026-10-11';
    expect(bucketForDueDate('2026-10-11', asOf)).toBe('current');
    expect(bucketForDueDate('2026-10-10', asOf)).toBe('days_1_30');
    expect(bucketForDueDate('2026-09-11', asOf)).toBe('days_1_30'); // 30 days
    expect(bucketForDueDate('2026-09-10', asOf)).toBe('days_31_60'); // 31 days
    expect(bucketForDueDate('2026-08-12', asOf)).toBe('days_31_60'); // 60 days
    expect(bucketForDueDate('2026-08-11', asOf)).toBe('days_61_90'); // 61 days
    expect(bucketForDueDate('2026-07-13', asOf)).toBe('days_61_90'); // 90 days
    expect(bucketForDueDate('2026-07-12', asOf)).toBe('days_91_plus'); // 91 days
  });
});

describe('buildAgingReport', () => {
  it('uses the unpaid balance, not the invoice total', () => {
    const report = buildAgingReport(
      [{ dueDate: '2026-09-01', outstandingPaise: 250_000n }],
      '2026-10-11',
    );
    expect(report.totalOutstandingPaise).toBe(250_000n);
    expect(report.buckets.find((b) => b.bucket === 'days_31_60')!.amountPaise).toBe(250_000n);
  });

  it('ignores fully paid invoices', () => {
    const report = buildAgingReport(
      [
        { dueDate: '2026-09-01', outstandingPaise: 0n },
        { dueDate: '2026-10-01', outstandingPaise: 100_000n },
      ],
      '2026-10-11',
    );
    expect(report.totalInvoiceCount).toBe(1);
    expect(report.totalOutstandingPaise).toBe(100_000n);
  });

  it('produces mutually exclusive buckets that sum to the total', () => {
    const report = buildAgingReport(
      [
        { dueDate: '2026-11-01', outstandingPaise: 100_000n }, // current
        { dueDate: '2026-10-11', outstandingPaise: 200_000n }, // current (due today)
        { dueDate: '2026-10-01', outstandingPaise: 300_000n }, // 1-30
        { dueDate: '2026-09-01', outstandingPaise: 400_000n }, // 31-60
        { dueDate: '2026-08-01', outstandingPaise: 500_000n }, // 61-90
        { dueDate: '2026-06-01', outstandingPaise: 600_000n }, // 91+
      ],
      '2026-10-11',
    );

    expect(report.buckets.map((b) => b.bucket)).toEqual([...AGING_BUCKETS]);
    expect(report.buckets.map((b) => b.amountPaise)).toEqual([
      300_000n,
      300_000n,
      400_000n,
      500_000n,
      600_000n,
    ]);
    const bucketSum = report.buckets.reduce((sum, b) => sum + b.amountPaise, 0n);
    expect(bucketSum).toBe(report.totalOutstandingPaise);
    expect(report.totalOutstandingPaise).toBe(2_100_000n);
    expect(report.totalOverduePaise).toBe(1_800_000n);
    expect(report.totalInvoiceCount).toBe(6);
  });

  it('is reproducible for a historical as-of date', () => {
    const invoices = [{ dueDate: '2026-09-01', outstandingPaise: 100_000n }];
    const past = buildAgingReport(invoices, '2026-09-15');
    const later = buildAgingReport(invoices, '2026-12-15');
    expect(past.buckets.find((b) => b.bucket === 'days_1_30')!.amountPaise).toBe(100_000n);
    expect(later.buckets.find((b) => b.bucket === 'days_91_plus')!.amountPaise).toBe(100_000n);
  });

  it('returns an empty report for a new business', () => {
    const report = buildAgingReport([], '2026-10-11');
    expect(report.totalOutstandingPaise).toBe(0n);
    expect(report.buckets.every((b) => b.amountPaise === 0n)).toBe(true);
  });
});

describe('deriveInvoiceStatus', () => {
  const base = {
    documentState: 'issued' as const,
    totalAmountPaise: 100_000n,
    outstandingPaise: 100_000n,
    dueDate: '2026-10-20',
    asOf: '2026-10-11',
  };

  it('derives lifecycle states first', () => {
    expect(deriveInvoiceStatus({ ...base, documentState: 'draft' })).toBe('draft');
    expect(deriveInvoiceStatus({ ...base, documentState: 'void' })).toBe('void');
  });

  it('derives paid from the balance, not a stored flag', () => {
    expect(deriveInvoiceStatus({ ...base, outstandingPaise: 0n })).toBe('paid');
  });

  it('derives overdue from the due date', () => {
    expect(deriveInvoiceStatus({ ...base, dueDate: '2026-10-10' })).toBe('overdue');
  });

  it('marks due-today separately from overdue', () => {
    expect(deriveInvoiceStatus({ ...base, dueDate: '2026-10-11' })).toBe('due_today');
  });

  it('marks partially paid invoices that are not yet due', () => {
    expect(deriveInvoiceStatus({ ...base, outstandingPaise: 40_000n })).toBe('partially_paid');
  });

  it('marks untouched invoices as current', () => {
    expect(deriveInvoiceStatus(base)).toBe('current');
  });
});
