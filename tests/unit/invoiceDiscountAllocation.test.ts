/**
 * invoiceDiscountAllocation.test.ts — invoice-level discount allocation across
 * inclusive and exclusive pricing, plus cess edge cases.
 *
 * These tests pin the behaviour that `public.create_invoice()` must mirror.
 * The matching pgTAP assertions live in
 * supabase/tests/03_invoice_engine_v2_test.sql.
 */

import { describe, expect, it } from 'vitest';
import {
  allocateInvoiceDiscount,
  calculateInvoiceTotals,
  calculateLine,
  InvoiceCalculationError,
} from '@/lib/invoiceCalculations';

// ---------------------------------------------------------------------------
// Inclusive pricing with an invoice-level discount
// ---------------------------------------------------------------------------

describe('Inclusive pricing with invoice-level discount', () => {
  it('validates the discount against the inclusive total, not the taxable value', () => {
    // 10 x Rs500 inclusive of 18% = Rs5,000 total, Rs4,237.29 taxable.
    // A Rs4,500 discount is larger than the taxable value but smaller than the
    // inclusive total, so it must be accepted.
    const totals = calculateInvoiceTotals(
      [{ description: 'W', quantity: '10', unitPricePaise: 50000n, taxRatePercent: 18 }],
      'intra_state',
      { priceIncludesTax: true, invoiceDiscountPaise: 450000n },
    );

    expect(totals.invoiceDiscountPaise).toBe(450000n);
    expect(totals.totalAmountPaise).toBe(50000n);
    expect(totals.taxableAmountPaise + totals.totalTaxPaise).toBe(totals.totalAmountPaise);
  });

  it('rejects a discount larger than the inclusive total', () => {
    expect(() =>
      calculateInvoiceTotals(
        [{ description: 'W', quantity: '10', unitPricePaise: 50000n, taxRatePercent: 18 }],
        'intra_state',
        { priceIncludesTax: true, invoiceDiscountPaise: 600000n },
      ),
    ).toThrow(InvoiceCalculationError);
  });

  it('back-solves the taxable value from the discounted inclusive amount', () => {
    // 10 x Rs500 inclusive of 18% = Rs5,000 gross, Rs100 invoice discount.
    const totals = calculateInvoiceTotals(
      [{ description: 'W', quantity: '10', unitPricePaise: 50000n, taxRatePercent: 18 }],
      'intra_state',
      { priceIncludesTax: true, invoiceDiscountPaise: 10000n },
    );

    // Net after discount is Rs4,900 inclusive.
    // taxable = 490000 * 10000 / 11800 = 415254 (rounded)
    expect(totals.taxableAmountPaise).toBe(415254n);
    expect(totals.totalTaxPaise).toBe(74746n);
    expect(totals.totalAmountPaise).toBe(490000n);
    expect(totals.taxableAmountPaise + totals.totalTaxPaise).toBe(totals.totalAmountPaise);
  });

  it('does not treat the inclusive gross as a taxable value', () => {
    const totals = calculateInvoiceTotals(
      [{ description: 'W', quantity: '10', unitPricePaise: 50000n, taxRatePercent: 18 }],
      'intra_state',
      { priceIncludesTax: true, invoiceDiscountPaise: 10000n },
    );

    // The bug being guarded against: taxable === gross - discount (490000).
    expect(totals.taxableAmountPaise).not.toBe(490000n);
    expect(totals.taxableAmountPaise).toBeLessThan(490000n);
  });

  it('keeps CGST + SGST equal to the total tax', () => {
    const totals = calculateInvoiceTotals(
      [{ description: 'W', quantity: '10', unitPricePaise: 50000n, taxRatePercent: 18 }],
      'intra_state',
      { priceIncludesTax: true, invoiceDiscountPaise: 10000n },
    );

    expect(totals.cgstPaise + totals.sgstPaise).toBe(totals.totalTaxPaise);
  });

  it('uses IGST for inclusive inter-state with a discount', () => {
    const totals = calculateInvoiceTotals(
      [{ description: 'W', quantity: '10', unitPricePaise: 50000n, taxRatePercent: 18 }],
      'inter_state',
      { priceIncludesTax: true, invoiceDiscountPaise: 10000n },
    );

    expect(totals.igstPaise).toBe(totals.totalTaxPaise);
    expect(totals.cgstPaise).toBe(0n);
    expect(totals.totalAmountPaise).toBe(490000n);
  });

  it('allocates across mixed-rate inclusive lines without negative totals', () => {
    const totals = calculateInvoiceTotals(
      [
        { description: 'A', quantity: '1', unitPricePaise: 118000n, taxRatePercent: 18 },
        { description: 'B', quantity: '1', unitPricePaise: 112000n, taxRatePercent: 12 },
      ],
      'intra_state',
      { priceIncludesTax: true, invoiceDiscountPaise: 30000n },
    );

    expect(totals.totalAmountPaise).toBe(200000n);
    expect(totals.taxableAmountPaise + totals.totalTaxPaise).toBe(totals.totalAmountPaise);
    for (const line of totals.lines) {
      expect(line.lineTotalPaise).toBeGreaterThanOrEqual(0n);
      expect(line.taxableAmountPaise).toBeGreaterThanOrEqual(0n);
    }
  });
});

// ---------------------------------------------------------------------------
// Exclusive pricing with an invoice-level discount
// ---------------------------------------------------------------------------

describe('Exclusive pricing with invoice-level discount', () => {
  it('treats gross minus discount as the taxable value', () => {
    const totals = calculateInvoiceTotals(
      [{ description: 'W', quantity: '10', unitPricePaise: 50000n, taxRatePercent: 18 }],
      'intra_state',
      { invoiceDiscountPaise: 10000n },
    );

    // Exclusive: taxable = 500000 - 10000 = 490000, tax = 88200.
    expect(totals.taxableAmountPaise).toBe(490000n);
    expect(totals.totalTaxPaise).toBe(88200n);
    expect(totals.totalAmountPaise).toBe(578200n);
  });

  it('reconciles taxable + tax to the total', () => {
    const totals = calculateInvoiceTotals(
      [{ description: 'W', quantity: '10', unitPricePaise: 50000n, taxRatePercent: 18 }],
      'intra_state',
      { invoiceDiscountPaise: 10000n },
    );

    expect(totals.taxableAmountPaise + totals.totalTaxPaise).toBe(totals.totalAmountPaise);
  });
});

// ---------------------------------------------------------------------------
// Proportional allocation across multiple lines
// ---------------------------------------------------------------------------

describe('Proportional discount allocation', () => {
  it('splits the discount in proportion to taxable value', () => {
    const lines = [
      calculateLine({ description: 'A', quantity: '1', unitPricePaise: 60000n }, 'intra_state'),
      calculateLine({ description: 'B', quantity: '1', unitPricePaise: 40000n }, 'intra_state'),
    ];

    const allocations = allocateInvoiceDiscount(lines, 10000n);

    expect(allocations[0]).toBe(6000n);
    expect(allocations[1]).toBe(4000n);
    expect(allocations[0]! + allocations[1]!).toBe(10000n);
  });

  it('allocates across three lines with different tax rates', () => {
    const totals = calculateInvoiceTotals(
      [
        { description: 'A', quantity: '1', unitPricePaise: 50000n, taxRatePercent: 18 },
        { description: 'B', quantity: '1', unitPricePaise: 30000n, taxRatePercent: 12 },
        { description: 'C', quantity: '1', unitPricePaise: 20000n, taxRatePercent: 5 },
      ],
      'intra_state',
      { invoiceDiscountPaise: 10000n },
    );

    expect(totals.invoiceDiscountPaise).toBe(10000n);
    expect(totals.taxableAmountPaise).toBe(90000n);
    expect(totals.taxableAmountPaise + totals.totalTaxPaise).toBe(totals.totalAmountPaise);
  });

  it('reconciles across 200 randomised inclusive multi-line invoices with discounts', () => {
    for (let i = 0; i < 200; i += 1) {
      const lines = Array.from({ length: 1 + (i % 4) }, (_, index) => ({
        description: `L${index}`,
        quantity: String(1 + ((i + index) % 3)),
        unitPricePaise: BigInt(5000 + ((i * 41 + index * 17) % 60000)),
        taxRatePercent: [0, 5, 12, 18, 28][(i + index) % 5]!,
      }));

      const base = calculateInvoiceTotals(lines, 'intra_state', { priceIncludesTax: true });
      const discount = (base.taxableAmountPaise * BigInt(1 + (i % 15))) / 100n;

      const totals = calculateInvoiceTotals(lines, 'intra_state', {
        priceIncludesTax: true,
        invoiceDiscountPaise: discount,
      });

      expect(totals.taxableAmountPaise + totals.totalTaxPaise).toBe(totals.totalAmountPaise);
      const lineSum = totals.lines.reduce((total, line) => total + line.lineTotalPaise, 0n);
      expect(lineSum).toBe(totals.totalAmountPaise);
    }
  });
});

// ---------------------------------------------------------------------------
// Rounding remainder
// ---------------------------------------------------------------------------

describe('Rounding remainder allocation', () => {
  it('gives the remainder to the largest line so the sum is exact', () => {
    const lines = [
      calculateLine({ description: 'A', quantity: '1', unitPricePaise: 33333n }, 'intra_state'),
      calculateLine({ description: 'B', quantity: '1', unitPricePaise: 33333n }, 'intra_state'),
      calculateLine({ description: 'C', quantity: '1', unitPricePaise: 33334n }, 'intra_state'),
    ];

    const allocations = allocateInvoiceDiscount(lines, 10000n);
    const sum = allocations.reduce((total, value) => total + value, 0n);

    expect(sum).toBe(10000n);
  });

  it('handles a discount of 1 paise across three equal lines', () => {
    const lines = [
      calculateLine({ description: 'A', quantity: '1', unitPricePaise: 100n }, 'intra_state'),
      calculateLine({ description: 'B', quantity: '1', unitPricePaise: 100n }, 'intra_state'),
      calculateLine({ description: 'C', quantity: '1', unitPricePaise: 100n }, 'intra_state'),
    ];

    const allocations = allocateInvoiceDiscount(lines, 1n);
    const sum = allocations.reduce((total, value) => total + value, 0n);

    expect(sum).toBe(1n);
  });

  it('rejects a discount larger than the taxable base', () => {
    const lines = [calculateLine({ description: 'A', quantity: '1', unitPricePaise: 1000n }, 'intra_state')];

    expect(() => allocateInvoiceDiscount(lines, 2000n)).toThrow(InvoiceCalculationError);
  });
});

// ---------------------------------------------------------------------------
// Largest-remainder allocation
// ---------------------------------------------------------------------------

describe('Largest-remainder allocation', () => {
  it('allocates 50 paise across 100 lines of 1 paise each', () => {
    const lines = Array.from({ length: 100 }, (_, i) =>
      calculateLine({ description: `L${i}`, quantity: '1', unitPricePaise: 1n }, 'intra_state'),
    );

    const allocations = allocateInvoiceDiscount(lines, 50n);
    const sum = allocations.reduce((total, value) => total + value, 0n);

    expect(sum).toBe(50n);
    // Every line has a 1-paise base, so no allocation may exceed 1.
    for (const value of allocations) {
      expect(value).toBeLessThanOrEqual(1n);
      expect(value).toBeGreaterThanOrEqual(0n);
    }
    // Exactly 50 lines receive 1 paise.
    expect(allocations.filter((v) => v === 1n).length).toBe(50);
  });

  it('matches the SQL largest-remainder result for 100 lines of 1 paise', () => {
    // SQL: base_total = 100, discount = 50.
    //   floor_i = floor(50 * 1 / 100) = 0 for every line
    //   frac_i  = mod(50 * 1, 100)    = 50 for every line
    //   remainder = 50 - 0 = 50
    //   order by frac desc, line_number asc -> the FIRST 50 lines get 1 paise.
    const lines = Array.from({ length: 100 }, (_, i) =>
      calculateLine({ description: `L${i}`, quantity: '1', unitPricePaise: 1n }, 'intra_state'),
    );

    const allocations = allocateInvoiceDiscount(lines, 50n);

    // The first 50 lines (index 0..49) receive exactly 1 paise; the rest 0.
    for (let i = 0; i < 100; i += 1) {
      expect(allocations[i]).toBe(i < 50 ? 1n : 0n);
    }
  });

  it('allocates across lines with different values', () => {
    const lines = [
      calculateLine({ description: 'A', quantity: '1', unitPricePaise: 60000n }, 'intra_state'),
      calculateLine({ description: 'B', quantity: '1', unitPricePaise: 30000n }, 'intra_state'),
      calculateLine({ description: 'C', quantity: '1', unitPricePaise: 10000n }, 'intra_state'),
    ];

    const allocations = allocateInvoiceDiscount(lines, 10000n);
    const sum = allocations.reduce((total, value) => total + value, 0n);

    expect(sum).toBe(10000n);
    expect(allocations[0]).toBe(6000n);
    expect(allocations[1]).toBe(3000n);
    expect(allocations[2]).toBe(1000n);
  });

  it('breaks equal fractional remainders by lowest line index', () => {
    // Three equal lines, 1 paise discount: all fractions are equal (1/3).
    // The single paise must go to the first line.
    const lines = [
      calculateLine({ description: 'A', quantity: '1', unitPricePaise: 100n }, 'intra_state'),
      calculateLine({ description: 'B', quantity: '1', unitPricePaise: 100n }, 'intra_state'),
      calculateLine({ description: 'C', quantity: '1', unitPricePaise: 100n }, 'intra_state'),
    ];

    const allocations = allocateInvoiceDiscount(lines, 1n);

    expect(allocations[0]).toBe(1n);
    expect(allocations[1]).toBe(0n);
    expect(allocations[2]).toBe(0n);
  });

  it('allocates a discount equal to the entire base', () => {
    const lines = [
      calculateLine({ description: 'A', quantity: '1', unitPricePaise: 60000n }, 'intra_state'),
      calculateLine({ description: 'B', quantity: '1', unitPricePaise: 40000n }, 'intra_state'),
    ];

    const allocations = allocateInvoiceDiscount(lines, 100000n);
    const sum = allocations.reduce((total, value) => total + value, 0n);

    expect(sum).toBe(100000n);
    expect(allocations[0]).toBe(60000n);
    expect(allocations[1]).toBe(40000n);
  });

  it('never allocates more than a line base, even with a full discount', () => {
    const lines = Array.from({ length: 7 }, (_, i) =>
      calculateLine({ description: `L${i}`, quantity: '1', unitPricePaise: BigInt(3 + i) }, 'intra_state'),
    );
    const base = lines.reduce((total, line) => total + line.taxableAmountPaise, 0n);

    const allocations = allocateInvoiceDiscount(lines, base);

    for (let i = 0; i < lines.length; i += 1) {
      expect(allocations[i]).toBe(lines[i]!.taxableAmountPaise);
    }
  });

  it('uses the inclusive base when priceIncludesTax is true', () => {
    const lines = [
      calculateLine({ description: 'A', quantity: '1', unitPricePaise: 118000n, taxRatePercent: 18 }, 'intra_state', true),
      calculateLine({ description: 'B', quantity: '1', unitPricePaise: 112000n, taxRatePercent: 12 }, 'intra_state', true),
    ];

    // Inclusive bases are 118000 and 112000 (total 230000).
    const allocations = allocateInvoiceDiscount(lines, 23000n, true);
    const sum = allocations.reduce((total, value) => total + value, 0n);

    expect(sum).toBe(23000n);
    expect(allocations[0]).toBe(11800n);
    expect(allocations[1]).toBe(11200n);
  });

  it('uses the exclusive base when priceIncludesTax is false', () => {
    const lines = [
      calculateLine({ description: 'A', quantity: '1', unitPricePaise: 118000n, taxRatePercent: 18 }, 'intra_state'),
      calculateLine({ description: 'B', quantity: '1', unitPricePaise: 112000n, taxRatePercent: 12 }, 'intra_state'),
    ];

    // Exclusive bases are the taxable values: 118000 and 112000.
    const allocations = allocateInvoiceDiscount(lines, 23000n, false);
    const sum = allocations.reduce((total, value) => total + value, 0n);

    expect(sum).toBe(23000n);
  });

  it('reconciles across 300 randomised allocations', () => {
    for (let i = 0; i < 300; i += 1) {
      const count = 1 + (i % 12);
      const lines = Array.from({ length: count }, (_, index) =>
        calculateLine(
          {
            description: `L${index}`,
            quantity: '1',
            unitPricePaise: BigInt(1 + ((i * 37 + index * 13) % 5000)),
          },
          'intra_state',
        ),
      );

      const base = lines.reduce((total, line) => total + line.taxableAmountPaise, 0n);
      const discount = (base * BigInt(1 + (i % 100))) / 100n;

      const allocations = allocateInvoiceDiscount(lines, discount);
      const sum = allocations.reduce((total, value) => total + value, 0n);

      expect(sum).toBe(discount);
      for (let k = 0; k < lines.length; k += 1) {
        expect(allocations[k]).toBeGreaterThanOrEqual(0n);
        expect(allocations[k]).toBeLessThanOrEqual(lines[k]!.taxableAmountPaise);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Cess edge cases
// ---------------------------------------------------------------------------

describe('Cess edge cases', () => {
  it('handles zero GST rate with positive cess (inclusive)', () => {
    // 12% cess, 0% GST. Must not divide by zero.
    const line = calculateLine(
      { description: 'C', quantity: '1', unitPricePaise: 11200n, taxRatePercent: 0, cessRatePercent: 12 },
      'intra_state',
      true,
    );

    expect(line.cgstPaise).toBe(0n);
    expect(line.sgstPaise).toBe(0n);
    expect(line.igstPaise).toBe(0n);
    expect(line.cessPaise).toBeGreaterThan(0n);
    expect(line.taxableAmountPaise + line.cessPaise).toBe(line.lineTotalPaise);
    expect(line.lineTotalPaise).toBe(11200n);
  });

  it('handles zero GST rate with positive cess (exclusive)', () => {
    const line = calculateLine(
      { description: 'C', quantity: '1', unitPricePaise: 10000n, taxRatePercent: 0, cessRatePercent: 12 },
      'intra_state',
    );

    expect(line.cgstPaise).toBe(0n);
    expect(line.sgstPaise).toBe(0n);
    expect(line.cessPaise).toBe(1200n);
    expect(line.lineTotalPaise).toBe(11200n);
  });

  it('handles zero GST rate with cess for inter-state inclusive', () => {
    const line = calculateLine(
      { description: 'C', quantity: '1', unitPricePaise: 11200n, taxRatePercent: 0, cessRatePercent: 12 },
      'inter_state',
      true,
    );

    expect(line.igstPaise).toBe(0n);
    expect(line.cessPaise).toBeGreaterThan(0n);
    expect(line.taxableAmountPaise + line.cessPaise).toBe(line.lineTotalPaise);
  });

  it('treats an exempt invoice as fully taxable value with no tax', () => {
    const totals = calculateInvoiceTotals(
      [{ description: 'E', quantity: '2', unitPricePaise: 25000n, taxRatePercent: 18, cessRatePercent: 12 }],
      'exempt',
      { priceIncludesTax: true },
    );

    expect(totals.totalTaxPaise).toBe(0n);
    expect(totals.taxableAmountPaise).toBe(50000n);
    expect(totals.totalAmountPaise).toBe(50000n);
  });

  it('zeroes cess on an exempt exclusive line even with a cess rate supplied', () => {
    const line = calculateLine(
      { description: 'E', quantity: '1', unitPricePaise: 100000n, taxRatePercent: 18, cessRatePercent: 12 },
      'exempt',
    );

    expect(line.cgstPaise).toBe(0n);
    expect(line.sgstPaise).toBe(0n);
    expect(line.igstPaise).toBe(0n);
    expect(line.cessPaise).toBe(0n);
    expect(line.taxableAmountPaise).toBe(100000n);
    expect(line.lineTotalPaise).toBe(100000n);
  });

  it('zeroes cess on an exempt inclusive line even with a cess rate supplied', () => {
    const line = calculateLine(
      { description: 'E', quantity: '1', unitPricePaise: 100000n, taxRatePercent: 18, cessRatePercent: 12 },
      'exempt',
      true,
    );

    expect(line.cgstPaise).toBe(0n);
    expect(line.sgstPaise).toBe(0n);
    expect(line.igstPaise).toBe(0n);
    expect(line.cessPaise).toBe(0n);
    expect(line.taxableAmountPaise).toBe(100000n);
    expect(line.lineTotalPaise).toBe(100000n);
  });

  it('rejects a negative cess rate', () => {
    // percentToBasisPoints rejects a negative percentage with MoneyParseError.
    expect(() =>
      calculateLine(
        { description: 'C', quantity: '1', unitPricePaise: 10000n, taxRatePercent: 18, cessRatePercent: -5 },
        'intra_state',
      ),
    ).toThrow();
  });

  it('reconciles GST plus cess on an inclusive line', () => {
    const line = calculateLine(
      { description: 'C', quantity: '3', unitPricePaise: 12345n, taxRatePercent: 18, cessRatePercent: 12 },
      'intra_state',
      true,
    );

    const taxTotal = line.cgstPaise + line.sgstPaise + line.igstPaise + line.cessPaise;
    expect(line.taxableAmountPaise + taxTotal).toBe(line.lineTotalPaise);
  });

  it('handles a tiny amount where cess rounds to zero', () => {
    // 4 paise at 12% cess = 0.48 paise -> rounds to 0.
    // The rate cannot be recovered from the amount, which is why the database
    // stores cess_rate_basis_points rather than reconstructing it.
    const line = calculateLine(
      { description: 'Tiny', quantity: '1', unitPricePaise: 4n, taxRatePercent: 0, cessRatePercent: 12 },
      'intra_state',
    );

    expect(line.cessPaise).toBe(0n);
    expect(line.taxableAmountPaise).toBe(4n);
    expect(line.lineTotalPaise).toBe(4n);
  });

  it('handles a tiny inclusive amount where cess rounds to zero', () => {
    const line = calculateLine(
      { description: 'Tiny', quantity: '1', unitPricePaise: 4n, taxRatePercent: 0, cessRatePercent: 12 },
      'intra_state',
      true,
    );

    expect(line.cessPaise).toBe(0n);
    expect(line.taxableAmountPaise).toBe(4n);
    expect(line.lineTotalPaise).toBe(4n);
  });
});
