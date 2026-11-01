/**
 * paymentAllocation.ts — how a payment is spread across invoices.
 *
 * RULES:
 *  1. A payment is never tied to exactly one invoice. Allocations live in their
 *     own table so one payment can settle several invoices and one invoice can
 *     receive several payments.
 *  2. Allocation is oldest-due-first (FIFO by due date, then invoice date).
 *  3. An allocation can never exceed the invoice's outstanding balance, and the
 *     sum of allocations can never exceed the payment amount.
 *  4. Any remainder stays as an unallocated advance on the payment — it is NOT
 *     forced onto an invoice and it never distorts invoice balances.
 *  5. Voided or draft invoices are never allocated to.
 *
 * The database enforces the same rules transactionally (see
 * supabase/migrations/*_payment_functions.sql); this module is the client-side
 * preview and the unit-tested reference implementation.
 */

import type { Paise } from './money';
import type { IsoDate } from './dateUtils';

export interface AllocatableInvoice {
  invoiceId: string;
  invoiceNumber: string;
  dueDate: IsoDate;
  invoiceDate: IsoDate;
  /** Remaining balance in paise (already net of existing allocations). */
  outstandingPaise: Paise;
  /** Only issued invoices can receive allocations. */
  documentState: 'draft' | 'issued' | 'void';
}

export interface AllocationPlanItem {
  invoiceId: string;
  invoiceNumber: string;
  dueDate: IsoDate;
  /** Amount applied to this invoice. */
  allocatedPaise: Paise;
  /** Invoice balance before this allocation. */
  balanceBeforePaise: Paise;
  /** Invoice balance after this allocation. */
  balanceAfterPaise: Paise;
}

export interface AllocationPlan {
  items: AllocationPlanItem[];
  allocatedTotalPaise: Paise;
  unallocatedPaise: Paise;
}

export class AllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllocationError';
  }
}

/** Sort invoices oldest-due-first, then oldest invoice date, then number. */
export function sortForAllocation(invoices: readonly AllocatableInvoice[]): AllocatableInvoice[] {
  return [...invoices].sort((a, b) => {
    if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
    if (a.invoiceDate !== b.invoiceDate) return a.invoiceDate < b.invoiceDate ? -1 : 1;
    return a.invoiceNumber.localeCompare(b.invoiceNumber);
  });
}

/**
 * Build an allocation plan for a payment amount.
 *
 * @param amountPaise  Payment amount (must be > 0).
 * @param invoices     Candidate invoices for the same customer and business.
 * @param options.manual  Explicit per-invoice amounts; when provided the FIFO
 *                        strategy is skipped and the amounts are validated.
 */
export function planAllocation(
  amountPaise: Paise,
  invoices: readonly AllocatableInvoice[],
  options: { manual?: ReadonlyArray<{ invoiceId: string; amountPaise: Paise }> } = {},
): AllocationPlan {
  if (amountPaise <= 0n) {
    throw new AllocationError('Payment amount must be greater than zero');
  }

  const eligible = invoices.filter(
    (invoice) => invoice.documentState === 'issued' && invoice.outstandingPaise > 0n,
  );

  const items: AllocationPlanItem[] = [];
  let remaining = amountPaise;

  if (options.manual) {
    const byId = new Map(eligible.map((invoice) => [invoice.invoiceId, invoice]));
    for (const entry of options.manual) {
      if (entry.amountPaise <= 0n) continue;
      const invoice = byId.get(entry.invoiceId);
      if (!invoice) {
        throw new AllocationError('Cannot allocate to an invoice that is not open for this customer');
      }
      if (entry.amountPaise > invoice.outstandingPaise) {
        throw new AllocationError(
          `Allocation to ${invoice.invoiceNumber} exceeds its outstanding balance`,
        );
      }
      if (entry.amountPaise > remaining) {
        throw new AllocationError('Allocations exceed the payment amount');
      }
      items.push({
        invoiceId: invoice.invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        dueDate: invoice.dueDate,
        allocatedPaise: entry.amountPaise,
        balanceBeforePaise: invoice.outstandingPaise,
        balanceAfterPaise: invoice.outstandingPaise - entry.amountPaise,
      });
      remaining -= entry.amountPaise;
    }
  } else {
    for (const invoice of sortForAllocation(eligible)) {
      if (remaining === 0n) break;
      const applied = remaining < invoice.outstandingPaise ? remaining : invoice.outstandingPaise;
      items.push({
        invoiceId: invoice.invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        dueDate: invoice.dueDate,
        allocatedPaise: applied,
        balanceBeforePaise: invoice.outstandingPaise,
        balanceAfterPaise: invoice.outstandingPaise - applied,
      });
      remaining -= applied;
    }
  }

  const allocatedTotalPaise = items.reduce<Paise>((sum, item) => sum + item.allocatedPaise, 0n);

  return {
    items,
    allocatedTotalPaise,
    unallocatedPaise: amountPaise - allocatedTotalPaise,
  };
}

/**
 * Validate a set of allocations against a payment and its invoices.
 * Returns a list of human-readable problems (empty when valid).
 */
export function validateAllocations(
  amountPaise: Paise,
  allocations: ReadonlyArray<{ invoiceId: string; amountPaise: Paise }>,
  invoices: readonly AllocatableInvoice[],
): string[] {
  const problems: string[] = [];
  const byId = new Map(invoices.map((invoice) => [invoice.invoiceId, invoice]));
  const seen = new Set<string>();
  let total = 0n;

  for (const allocation of allocations) {
    if (allocation.amountPaise <= 0n) {
      problems.push('Allocation amounts must be greater than zero');
      continue;
    }
    if (seen.has(allocation.invoiceId)) {
      problems.push('The same invoice cannot be allocated twice in one payment');
    }
    seen.add(allocation.invoiceId);

    const invoice = byId.get(allocation.invoiceId);
    if (!invoice) {
      problems.push('Allocation references an unknown invoice');
      continue;
    }
    if (invoice.documentState !== 'issued') {
      problems.push(`Invoice ${invoice.invoiceNumber} is not issued and cannot receive payments`);
    }
    if (allocation.amountPaise > invoice.outstandingPaise) {
      problems.push(`Allocation to ${invoice.invoiceNumber} exceeds its outstanding balance`);
    }
    total += allocation.amountPaise;
  }

  if (total > amountPaise) {
    problems.push('Allocations exceed the payment amount');
  }

  return problems;
}
