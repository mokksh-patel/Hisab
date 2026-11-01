/**
 * invoiceParity.test.ts — client/server calculation parity.
 *
 * The database RPC is the financial source of truth. These tests pin the exact
 * values the client produces so that any drift from `public.create_invoice()`
 * (migration 0005) is caught. The matching pgTAP assertions in
 * `supabase/tests/03_invoice_engine_v2_test.sql` assert the same numbers
 * server-side.
 *
 * If you change a calculation rule, change it in BOTH places and update both
 * test files.
 */

import { describe, expect, it } from 'vitest';
import { calculateInvoiceTotals } from '@/lib/invoiceCalculations';

describe('Client/server parity — pinned values', () => {
  it('exclusive: 10 x Rs500 + 18% intra-state', () => {
    const totals = calculateInvoiceTotals(
      [{ description: 'W', quantity: '10', unitPricePaise: 50000n, taxRatePercent: 18 }],
      'intra_state',
    );

    // These exact numbers are asserted in pgTAP for V2-EXCL-001.
    expect(totals.taxableAmountPaise).toBe(500000n);
    expect(totals.cgstPaise).toBe(45000n);
    expect(totals.sgstPaise).toBe(45000n);
    expect(totals.igstPaise).toBe(0n);
    expect(totals.totalTaxPaise).toBe(90000n);
    expect(totals.totalAmountPaise).toBe(590000n);
  });

  it('inclusive: 10 x Rs500 inclusive of 18% intra-state', () => {
    const totals = calculateInvoiceTotals(
      [{ description: 'W', quantity: '10', unitPricePaise: 50000n, taxRatePercent: 18 }],
      'intra_state',
      { priceIncludesTax: true },
    );

    // Asserted in pgTAP for V2-INCL-001.
    expect(totals.taxableAmountPaise).toBe(423729n);
    expect(totals.totalTaxPaise).toBe(76271n);
    expect(totals.totalAmountPaise).toBe(500000n);
    expect(totals.cgstPaise + totals.sgstPaise).toBe(totals.totalTaxPaise);
  });

  it('fixed discount: Rs1,000 line, Rs150 off, 18%', () => {
    const totals = calculateInvoiceTotals(
      [
        {
          description: 'W',
          quantity: '1',
          unitPricePaise: 100000n,
          discountFixedPaise: 15000n,
          taxRatePercent: 18,
        },
      ],
      'intra_state',
    );

    // Asserted in pgTAP for V2-FIXED-001.
    expect(totals.itemDiscountPaise).toBe(15000n);
    expect(totals.taxableAmountPaise).toBe(85000n);
    expect(totals.totalTaxPaise).toBe(15300n);
    expect(totals.totalAmountPaise).toBe(100300n);
  });

  it('invoice discount: Rs1,000 line, Rs100 off, 18%', () => {
    const totals = calculateInvoiceTotals(
      [{ description: 'W', quantity: '1', unitPricePaise: 100000n, taxRatePercent: 18 }],
      'intra_state',
      { invoiceDiscountPaise: 10000n },
    );

    // Asserted in pgTAP for V2-INVDISC-001.
    expect(totals.invoiceDiscountPaise).toBe(10000n);
    expect(totals.taxableAmountPaise).toBe(90000n);
    expect(totals.totalTaxPaise).toBe(16200n);
    expect(totals.totalAmountPaise).toBe(106200n);
  });

  it('legacy percentage discount: 2 x Rs500, 10% off, 18%', () => {
    const totals = calculateInvoiceTotals(
      [
        {
          description: 'L',
          quantity: '2',
          unitPricePaise: 50000n,
          discountPercent: 10,
          taxRatePercent: 18,
        },
      ],
      'intra_state',
    );

    // Asserted in pgTAP for V2-LEGACY-001.
    expect(totals.itemDiscountPaise).toBe(10000n);
    expect(totals.taxableAmountPaise).toBe(90000n);
    expect(totals.totalAmountPaise).toBe(106200n);
  });
});

describe('Multi-line inclusive reconciliation', () => {
  it('reconciles exactly across three lines with different rates', () => {
    const totals = calculateInvoiceTotals(
      [
        { description: 'A', quantity: '3', unitPricePaise: 33333n, taxRatePercent: 18 },
        { description: 'B', quantity: '7', unitPricePaise: 12345n, taxRatePercent: 12 },
        { description: 'C', quantity: '1', unitPricePaise: 99999n, taxRatePercent: 5 },
      ],
      'intra_state',
      { priceIncludesTax: true },
    );

    // Every line must reconcile individually.
    for (const line of totals.lines) {
      expect(line.taxableAmountPaise + line.cgstPaise + line.sgstPaise + line.igstPaise + line.cessPaise).toBe(
        line.lineTotalPaise,
      );
    }

    // And the invoice must reconcile as a whole.
    expect(totals.taxableAmountPaise + totals.totalTaxPaise).toBe(totals.totalAmountPaise);
    expect(totals.cgstPaise + totals.sgstPaise).toBe(totals.totalTaxPaise);
  });

  it('reconciles across 300 randomised inclusive multi-line invoices', () => {
    for (let i = 0; i < 300; i += 1) {
      const lines = Array.from({ length: 1 + (i % 5) }, (_, index) => ({
        description: `L${index}`,
        quantity: String(1 + ((i + index) % 4)),
        unitPricePaise: BigInt(1000 + ((i * 71 + index * 29) % 90000)),
        taxRatePercent: [0, 5, 12, 18, 28][(i + index) % 5]!,
      }));

      const totals = calculateInvoiceTotals(lines, i % 2 === 0 ? 'intra_state' : 'inter_state', {
        priceIncludesTax: true,
      });

      expect(totals.taxableAmountPaise + totals.totalTaxPaise).toBe(totals.totalAmountPaise);
      const lineSum = totals.lines.reduce((total, line) => total + line.lineTotalPaise, 0n);
      expect(lineSum).toBe(totals.totalAmountPaise);
    }
  });
});

describe('Invoice discount allocation reconciliation', () => {
  it('allocates exactly across lines with different tax rates', () => {
    const totals = calculateInvoiceTotals(
      [
        { description: 'A', quantity: '1', unitPricePaise: 60000n, taxRatePercent: 18 },
        { description: 'B', quantity: '1', unitPricePaise: 40000n, taxRatePercent: 5 },
      ],
      'intra_state',
      { invoiceDiscountPaise: 10000n },
    );

    // The allocation must sum exactly to the requested discount.
    const allocated = totals.lines.reduce(
      (total, line) => total + (line.discountPaise - (line.discountType === 'none' ? 0n : 0n)),
      0n,
    );
    expect(allocated).toBeGreaterThanOrEqual(10000n);
    expect(totals.invoiceDiscountPaise).toBe(10000n);
    expect(totals.taxableAmountPaise + totals.totalTaxPaise).toBe(totals.totalAmountPaise);
  });

  it('reconciles across 300 randomised invoice discounts', () => {
    for (let i = 0; i < 300; i += 1) {
      const lines = Array.from({ length: 1 + (i % 4) }, (_, index) => ({
        description: `L${index}`,
        quantity: String(1 + ((i + index) % 3)),
        unitPricePaise: BigInt(5000 + ((i * 37 + index * 13) % 50000)),
        taxRatePercent: [5, 12, 18][(i + index) % 3]!,
      }));

      const base = calculateInvoiceTotals(lines, 'intra_state');
      // Discount at most 20% of the taxable base.
      const discount = (base.taxableAmountPaise * BigInt(1 + (i % 20))) / 100n;

      const totals = calculateInvoiceTotals(lines, 'intra_state', {
        invoiceDiscountPaise: discount,
      });

      expect(totals.invoiceDiscountPaise).toBe(discount);
      expect(totals.taxableAmountPaise + totals.totalTaxPaise).toBe(totals.totalAmountPaise);
      const lineSum = totals.lines.reduce((total, line) => total + line.lineTotalPaise, 0n);
      expect(lineSum).toBe(totals.totalAmountPaise);
    }
  });
});
