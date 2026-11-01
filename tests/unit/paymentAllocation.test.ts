import { describe, expect, it } from 'vitest';
import {
  AllocationError,
  planAllocation,
  sortForAllocation,
  validateAllocations,
  type AllocatableInvoice,
} from '@/lib/paymentAllocation';

const invoice = (
  id: string,
  dueDate: string,
  outstandingPaise: bigint,
  overrides: Partial<AllocatableInvoice> = {},
): AllocatableInvoice => ({
  invoiceId: id,
  invoiceNumber: `INV-${id}`,
  dueDate,
  invoiceDate: '2026-09-01',
  outstandingPaise,
  documentState: 'issued',
  ...overrides,
});

describe('sortForAllocation', () => {
  it('orders by due date, then invoice date, then number', () => {
    const sorted = sortForAllocation([
      invoice('C', '2026-10-20', 100n),
      invoice('A', '2026-10-01', 100n),
      invoice('B', '2026-10-01', 100n, { invoiceDate: '2026-08-01' }),
    ]);
    expect(sorted.map((i) => i.invoiceId)).toEqual(['B', 'A', 'C']);
  });
});

describe('planAllocation (FIFO)', () => {
  it('settles the oldest invoice first', () => {
    const plan = planAllocation(100_000n, [
      invoice('new', '2026-11-01', 800_000n),
      invoice('old', '2026-09-01', 600_000n),
    ]);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.invoiceId).toBe('old');
    expect(plan.items[0]!.allocatedPaise).toBe(100_000n);
    expect(plan.items[0]!.balanceAfterPaise).toBe(500_000n);
    expect(plan.unallocatedPaise).toBe(0n);
  });

  it('spreads one payment across two invoices (acceptance test 3)', () => {
    // ₹10,000 payment; invoice A has ₹6,000 balance, invoice B has ₹8,000.
    const plan = planAllocation(1_000_000n, [
      invoice('A', '2026-09-01', 600_000n),
      invoice('B', '2026-09-15', 800_000n),
    ]);
    expect(plan.items).toHaveLength(2);
    expect(plan.items[0]).toMatchObject({ invoiceId: 'A', allocatedPaise: 600_000n, balanceAfterPaise: 0n });
    expect(plan.items[1]).toMatchObject({ invoiceId: 'B', allocatedPaise: 400_000n, balanceAfterPaise: 400_000n });
    expect(plan.allocatedTotalPaise).toBe(1_000_000n);
    expect(plan.unallocatedPaise).toBe(0n);
  });

  it('keeps an overpayment as an unallocated advance (acceptance test 4)', () => {
    const plan = planAllocation(1_200_000n, [invoice('A', '2026-09-01', 1_000_000n)]);
    expect(plan.allocatedTotalPaise).toBe(1_000_000n);
    expect(plan.unallocatedPaise).toBe(200_000n);
  });

  it('leaves the whole amount unallocated when there are no open invoices', () => {
    const plan = planAllocation(500_000n, []);
    expect(plan.items).toHaveLength(0);
    expect(plan.unallocatedPaise).toBe(500_000n);
  });

  it('ignores draft, void and fully paid invoices', () => {
    const plan = planAllocation(500_000n, [
      invoice('draft', '2026-09-01', 500_000n, { documentState: 'draft' }),
      invoice('void', '2026-09-01', 500_000n, { documentState: 'void' }),
      invoice('paid', '2026-09-01', 0n),
    ]);
    expect(plan.items).toHaveLength(0);
    expect(plan.unallocatedPaise).toBe(500_000n);
  });

  it('rejects a non-positive payment amount', () => {
    expect(() => planAllocation(0n, [])).toThrow(AllocationError);
    expect(() => planAllocation(-1n, [])).toThrow(AllocationError);
  });
});

describe('planAllocation (manual)', () => {
  it('honours explicit amounts', () => {
    const plan = planAllocation(
      1_000_000n,
      [invoice('A', '2026-09-01', 600_000n), invoice('B', '2026-09-15', 800_000n)],
      { manual: [{ invoiceId: 'B', amountPaise: 300_000n }] },
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.invoiceId).toBe('B');
    expect(plan.unallocatedPaise).toBe(700_000n);
  });

  it('rejects over-allocation to a single invoice', () => {
    expect(() =>
      planAllocation(1_000_000n, [invoice('A', '2026-09-01', 600_000n)], {
        manual: [{ invoiceId: 'A', amountPaise: 700_000n }],
      }),
    ).toThrow(AllocationError);
  });

  it('rejects allocations exceeding the payment', () => {
    expect(() =>
      planAllocation(
        500_000n,
        [invoice('A', '2026-09-01', 600_000n), invoice('B', '2026-09-15', 600_000n)],
        {
          manual: [
            { invoiceId: 'A', amountPaise: 300_000n },
            { invoiceId: 'B', amountPaise: 300_000n },
          ],
        },
      ),
    ).toThrow(AllocationError);
  });

  it('rejects unknown invoices', () => {
    expect(() =>
      planAllocation(100n, [], { manual: [{ invoiceId: 'ghost', amountPaise: 100n }] }),
    ).toThrow(AllocationError);
  });
});

describe('validateAllocations', () => {
  const invoices = [invoice('A', '2026-09-01', 600_000n), invoice('B', '2026-09-15', 800_000n)];

  it('accepts a valid allocation set', () => {
    expect(
      validateAllocations(1_000_000n, [{ invoiceId: 'A', amountPaise: 600_000n }], invoices),
    ).toEqual([]);
  });

  it('flags over-allocation, duplicates and unknown invoices', () => {
    const problems = validateAllocations(
      1_000_000n,
      [
        { invoiceId: 'A', amountPaise: 700_000n },
        { invoiceId: 'A', amountPaise: 100n },
        { invoiceId: 'ghost', amountPaise: 100n },
      ],
      invoices,
    );
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });

  it('flags allocations that exceed the payment amount', () => {
    const problems = validateAllocations(
      500_000n,
      [
        { invoiceId: 'A', amountPaise: 400_000n },
        { invoiceId: 'B', amountPaise: 400_000n },
      ],
      invoices,
    );
    expect(problems).toContain('Allocations exceed the payment amount');
  });

  it('flags non-positive amounts', () => {
    expect(validateAllocations(100n, [{ invoiceId: 'A', amountPaise: 0n }], invoices)).toContain(
      'Allocation amounts must be greater than zero',
    );
  });
});
