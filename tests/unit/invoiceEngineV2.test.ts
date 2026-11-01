/**
 * invoiceEngineV2.test.ts — Invoice Engine V2 calculations.
 *
 * Covers GST-inclusive and exclusive pricing, fixed and percentage discounts,
 * invoice-level discount allocation, CGST/SGST/IGST splits, zero-tax lines,
 * rounding reconciliation and multi-rate invoices.
 *
 * Every assertion checks exact paise values. No floating point anywhere.
 */

import { describe, expect, it } from 'vitest';
import {
  allocateInvoiceDiscount,
  calculateInvoiceTotals,
  calculateLine,
  InvoiceCalculationError,
  placeOfSupplyWarning,
} from '@/lib/invoiceCalculations';

// ---------------------------------------------------------------------------
// GST-exclusive pricing
// ---------------------------------------------------------------------------

describe('GST-exclusive pricing', () => {
  it('computes the spec example: 10 x Rs500 + 18% = Rs5,900', () => {
    const totals = calculateInvoiceTotals(
      [{ description: 'Item', quantity: '10', unitPricePaise: 50000n, taxRatePercent: 18 }],
      'intra_state',
    );

    expect(totals.taxableAmountPaise).toBe(500000n);
    expect(totals.totalTaxPaise).toBe(90000n);
    expect(totals.totalAmountPaise).toBe(590000n);
  });

  it('splits intra-state GST into equal CGST and SGST', () => {
    const totals = calculateInvoiceTotals(
      [{ description: 'Item', quantity: '10', unitPricePaise: 50000n, taxRatePercent: 18 }],
      'intra_state',
    );

    expect(totals.cgstPaise).toBe(45000n);
    expect(totals.sgstPaise).toBe(45000n);
    expect(totals.igstPaise).toBe(0n);
  });

  it('uses IGST only for inter-state supply', () => {
    const totals = calculateInvoiceTotals(
      [{ description: 'Item', quantity: '10', unitPricePaise: 50000n, taxRatePercent: 18 }],
      'inter_state',
    );

    expect(totals.igstPaise).toBe(90000n);
    expect(totals.cgstPaise).toBe(0n);
    expect(totals.sgstPaise).toBe(0n);
    expect(totals.totalAmountPaise).toBe(590000n);
  });

  it('charges no tax for exempt supply', () => {
    const totals = calculateInvoiceTotals(
      [{ description: 'Item', quantity: '10', unitPricePaise: 50000n, taxRatePercent: 18 }],
      'exempt',
    );

    expect(totals.totalTaxPaise).toBe(0n);
    expect(totals.totalAmountPaise).toBe(500000n);
  });

  it('handles a zero-rate line', () => {
    const totals = calculateInvoiceTotals(
      [{ description: 'Item', quantity: '3', unitPricePaise: 10000n, taxRatePercent: 0 }],
      'intra_state',
    );

    expect(totals.totalTaxPaise).toBe(0n);
    expect(totals.totalAmountPaise).toBe(30000n);
  });

  it('splits an odd basis-point rate without losing a paise', () => {
    // 5% -> 250bp CGST + 250bp SGST.
    const totals = calculateInvoiceTotals(
      [{ description: 'Item', quantity: '1', unitPricePaise: 100000n, taxRatePercent: 5 }],
      'intra_state',
    );

    expect(totals.cgstPaise + totals.sgstPaise).toBe(totals.totalTaxPaise);
    expect(totals.totalTaxPaise).toBe(5000n);
  });
});

// ---------------------------------------------------------------------------
// GST-inclusive pricing
// ---------------------------------------------------------------------------

describe('GST-inclusive pricing', () => {
  it('computes the spec example: Rs5,000 inclusive of 18%', () => {
    const totals = calculateInvoiceTotals(
      [{ description: 'Item', quantity: '10', unitPricePaise: 50000n, taxRatePercent: 18 }],
      'intra_state',
      { priceIncludesTax: true },
    );

    // Customer pays exactly Rs5,000.
    expect(totals.totalAmountPaise).toBe(500000n);
    // Taxable value back-solved: 500000 * 10000 / 11800 = 423729 (rounded).
    expect(totals.taxableAmountPaise).toBe(423729n);
    // Tax is the remainder, so the line reconciles exactly.
    expect(totals.totalTaxPaise).toBe(76271n);
  });

  it('always reconciles taxable + tax to the entered amount', () => {
    const totals = calculateInvoiceTotals(
      [{ description: 'Item', quantity: '10', unitPricePaise: 50000n, taxRatePercent: 18 }],
      'intra_state',
      { priceIncludesTax: true },
    );

    expect(totals.taxableAmountPaise + totals.totalTaxPaise).toBe(totals.totalAmountPaise);
  });

  it('splits inclusive intra-state tax into CGST and SGST that sum exactly', () => {
    const totals = calculateInvoiceTotals(
      [{ description: 'Item', quantity: '10', unitPricePaise: 50000n, taxRatePercent: 18 }],
      'intra_state',
      { priceIncludesTax: true },
    );

    expect(totals.cgstPaise + totals.sgstPaise).toBe(totals.totalTaxPaise);
    expect(totals.igstPaise).toBe(0n);
  });

  it('uses IGST for inclusive inter-state supply', () => {
    const totals = calculateInvoiceTotals(
      [{ description: 'Item', quantity: '10', unitPricePaise: 50000n, taxRatePercent: 18 }],
      'inter_state',
      { priceIncludesTax: true },
    );

    expect(totals.igstPaise).toBe(totals.totalTaxPaise);
    expect(totals.cgstPaise).toBe(0n);
    expect(totals.totalAmountPaise).toBe(500000n);
  });

  it('treats a zero-rate inclusive line as fully taxable value', () => {
    const totals = calculateInvoiceTotals(
      [{ description: 'Item', quantity: '2', unitPricePaise: 25000n, taxRatePercent: 0 }],
      'intra_state',
      { priceIncludesTax: true },
    );

    expect(totals.totalTaxPaise).toBe(0n);
    expect(totals.taxableAmountPaise).toBe(50000n);
    expect(totals.totalAmountPaise).toBe(50000n);
  });

  it('reconciles across many inclusive lines with different rates', () => {
    const totals = calculateInvoiceTotals(
      [
        { description: 'A', quantity: '3', unitPricePaise: 33333n, taxRatePercent: 18 },
        { description: 'B', quantity: '7', unitPricePaise: 12345n, taxRatePercent: 12 },
        { description: 'C', quantity: '1', unitPricePaise: 99999n, taxRatePercent: 5 },
      ],
      'intra_state',
      { priceIncludesTax: true },
    );

    expect(totals.taxableAmountPaise + totals.totalTaxPaise).toBe(totals.totalAmountPaise);
    expect(totals.cgstPaise + totals.sgstPaise).toBe(totals.totalTaxPaise);
  });
});

// ---------------------------------------------------------------------------
// Discounts
// ---------------------------------------------------------------------------

describe('Item-level discounts', () => {
  it('applies a percentage discount before tax', () => {
    const line = calculateLine(
      { description: 'Item', quantity: '1', unitPricePaise: 100000n, discountPercent: 10, taxRatePercent: 18 },
      'intra_state',
    );

    expect(line.discountPaise).toBe(10000n);
    expect(line.taxableAmountPaise).toBe(90000n);
    expect(line.cgstPaise).toBe(8100n);
    expect(line.lineTotalPaise).toBe(106200n);
  });

  it('applies a fixed discount before tax', () => {
    const line = calculateLine(
      {
        description: 'Item',
        quantity: '1',
        unitPricePaise: 100000n,
        discountFixedPaise: 15000n,
        taxRatePercent: 18,
      },
      'intra_state',
    );

    expect(line.discountType).toBe('fixed');
    expect(line.discountPaise).toBe(15000n);
    expect(line.taxableAmountPaise).toBe(85000n);
    expect(line.cgstPaise).toBe(7650n);
    expect(line.lineTotalPaise).toBe(100300n);
  });

  it('rejects a fixed discount larger than the line amount', () => {
    expect(() =>
      calculateLine(
        { description: 'Item', quantity: '1', unitPricePaise: 1000n, discountFixedPaise: 2000n },
        'intra_state',
      ),
    ).toThrow(InvoiceCalculationError);
  });

  it('prefers percentage when both discount types are supplied', () => {
    const line = calculateLine(
      {
        description: 'Item',
        quantity: '1',
        unitPricePaise: 100000n,
        discountPercent: 10,
        discountFixedPaise: 5000n,
      },
      'intra_state',
    );

    expect(line.discountType).toBe('percent');
    expect(line.discountPaise).toBe(10000n);
  });

  it('rounds a percentage discount to the nearest paise', () => {
    // 33333 * 33.33% = 11109.8889 -> 11110
    const line = calculateLine(
      { description: 'Item', quantity: '1', unitPricePaise: 33333n, discountPercent: '33.33' },
      'intra_state',
    );

    expect(line.discountPaise).toBe(11110n);
  });
});

describe('Invoice-level discount allocation', () => {
  it('allocates proportionally to taxable value', () => {
    const totals = calculateInvoiceTotals(
      [
        { description: 'A', quantity: '1', unitPricePaise: 60000n, taxRatePercent: 18 },
        { description: 'B', quantity: '1', unitPricePaise: 40000n, taxRatePercent: 18 },
      ],
      'intra_state',
      { invoiceDiscountPaise: 10000n },
    );

    // 60/40 split of 10000.
    expect(totals.invoiceDiscountPaise).toBe(10000n);
    expect(totals.taxableAmountPaise).toBe(90000n);
  });

  it('distributes the rounding remainder so the allocation sums exactly', () => {
    const lines = [
      calculateLine({ description: 'A', quantity: '1', unitPricePaise: 33333n }, 'intra_state'),
      calculateLine({ description: 'B', quantity: '1', unitPricePaise: 33333n }, 'intra_state'),
      calculateLine({ description: 'C', quantity: '1', unitPricePaise: 33334n }, 'intra_state'),
    ];

    const allocations = allocateInvoiceDiscount(lines, 10000n);
    const sum = allocations.reduce((total, value) => total + value, 0n);

    expect(sum).toBe(10000n);
  });

  it('rejects an invoice discount larger than the taxable value', () => {
    expect(() =>
      calculateInvoiceTotals(
        [{ description: 'A', quantity: '1', unitPricePaise: 1000n }],
        'intra_state',
        { invoiceDiscountPaise: 2000n },
      ),
    ).toThrow(InvoiceCalculationError);
  });

  it('recomputes tax on the reduced taxable value', () => {
    const totals = calculateInvoiceTotals(
      [{ description: 'A', quantity: '1', unitPricePaise: 100000n, taxRatePercent: 18 }],
      'intra_state',
      { invoiceDiscountPaise: 10000n },
    );

    // Taxable 90000, 18% -> 16200 total tax.
    expect(totals.taxableAmountPaise).toBe(90000n);
    expect(totals.totalTaxPaise).toBe(16200n);
    expect(totals.totalAmountPaise).toBe(106200n);
  });

  it('combines item and invoice discounts', () => {
    const totals = calculateInvoiceTotals(
      [
        {
          description: 'A',
          quantity: '1',
          unitPricePaise: 100000n,
          discountPercent: 10,
          taxRatePercent: 18,
        },
      ],
      'intra_state',
      { invoiceDiscountPaise: 5000n },
    );

    expect(totals.itemDiscountPaise).toBe(10000n);
    expect(totals.invoiceDiscountPaise).toBe(5000n);
    expect(totals.discountPaise).toBe(15000n);
    expect(totals.taxableAmountPaise).toBe(85000n);
  });
});

// ---------------------------------------------------------------------------
// Multi-line reconciliation
// ---------------------------------------------------------------------------

describe('Multi-line reconciliation', () => {
  it('sums line totals exactly to the invoice total', () => {
    const totals = calculateInvoiceTotals(
      [
        { description: 'A', quantity: '2', unitPricePaise: 12345n, taxRatePercent: 18 },
        { description: 'B', quantity: '1.5', unitPricePaise: 9999n, taxRatePercent: 12 },
        { description: 'C', quantity: '0.25', unitPricePaise: 77777n, taxRatePercent: 5 },
      ],
      'intra_state',
    );

    const lineSum = totals.lines.reduce((total, line) => total + line.lineTotalPaise, 0n);
    expect(lineSum).toBe(totals.totalAmountPaise);
  });

  it('keeps totals stable across 200 randomised exclusive invoices', () => {
    for (let i = 0; i < 200; i += 1) {
      const lines = Array.from({ length: 1 + (i % 4) }, (_, index) => ({
        description: `L${index}`,
        quantity: String(1 + (i % 5)),
        unitPricePaise: BigInt(1000 + ((i * 37 + index * 11) % 90000)),
        taxRatePercent: [0, 5, 12, 18, 28][(i + index) % 5]!,
      }));

      const totals = calculateInvoiceTotals(lines, i % 2 === 0 ? 'intra_state' : 'inter_state');
      const lineSum = totals.lines.reduce((total, line) => total + line.lineTotalPaise, 0n);

      expect(lineSum).toBe(totals.totalAmountPaise);
      expect(totals.taxableAmountPaise + totals.totalTaxPaise).toBe(totals.totalAmountPaise);
    }
  });

  it('keeps totals stable across 200 randomised inclusive invoices', () => {
    for (let i = 0; i < 200; i += 1) {
      const lines = Array.from({ length: 1 + (i % 3) }, (_, index) => ({
        description: `L${index}`,
        quantity: String(1 + (i % 4)),
        unitPricePaise: BigInt(1000 + ((i * 53 + index * 17) % 90000)),
        taxRatePercent: [0, 5, 12, 18, 28][(i + index) % 5]!,
      }));

      const totals = calculateInvoiceTotals(lines, 'intra_state', { priceIncludesTax: true });
      const lineSum = totals.lines.reduce((total, line) => total + line.lineTotalPaise, 0n);

      expect(lineSum).toBe(totals.totalAmountPaise);
      expect(totals.taxableAmountPaise + totals.totalTaxPaise).toBe(totals.totalAmountPaise);
    }
  });
});

// ---------------------------------------------------------------------------
// Place-of-supply validation
// ---------------------------------------------------------------------------

describe('placeOfSupplyWarning', () => {
  it('warns when the business state is missing', () => {
    expect(placeOfSupplyWarning(null, '24', 'intra_state')).toContain('business state');
  });

  it('warns when the place of supply is missing', () => {
    expect(placeOfSupplyWarning('24', null, 'intra_state')).toContain('Place of supply');
  });

  it('returns null when both states are present', () => {
    expect(placeOfSupplyWarning('24', '27', 'inter_state')).toBeNull();
  });

  it('returns null for exempt supply regardless of state', () => {
    expect(placeOfSupplyWarning(null, null, 'exempt')).toBeNull();
  });
});
