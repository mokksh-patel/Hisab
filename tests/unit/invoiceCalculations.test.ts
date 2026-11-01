import { describe, expect, it } from 'vitest';
import {
  InvoiceCalculationError,
  calculateInvoiceTotals,
  calculateLine,
  calculateOutstanding,
  formatQuantity,
  isFullyPaid,
  parseQuantity,
  resolveGstMode,
} from '@/lib/invoiceCalculations';

describe('parseQuantity / formatQuantity', () => {
  it('parses quantities to 3 decimal places', () => {
    expect(parseQuantity('1')).toBe(1000n);
    expect(parseQuantity('1.5')).toBe(1500n);
    expect(parseQuantity('0.25')).toBe(250n);
    expect(parseQuantity('12.125')).toBe(12_125n);
  });

  it('rejects invalid quantities', () => {
    expect(() => parseQuantity('')).toThrow(InvoiceCalculationError);
    expect(() => parseQuantity('1.2345')).toThrow(InvoiceCalculationError);
    expect(() => parseQuantity('-1')).toThrow(InvoiceCalculationError);
    expect(() => parseQuantity('abc')).toThrow(InvoiceCalculationError);
  });

  it('formats back to a trimmed string', () => {
    expect(formatQuantity(1000n)).toBe('1');
    expect(formatQuantity(1500n)).toBe('1.5');
    expect(formatQuantity(250n)).toBe('0.25');
    expect(formatQuantity(12_125n)).toBe('12.125');
  });
});

describe('resolveGstMode', () => {
  it('is intra-state when supplier and place of supply match', () => {
    expect(resolveGstMode('24', '24')).toBe('intra_state');
  });

  it('is inter-state when they differ', () => {
    expect(resolveGstMode('24', '27')).toBe('inter_state');
  });

  it('defaults to intra-state when data is missing', () => {
    expect(resolveGstMode(null, '27')).toBe('intra_state');
    expect(resolveGstMode('24', undefined)).toBe('intra_state');
  });
});

describe('calculateLine', () => {
  it('computes a simple intra-state line', () => {
    const line = calculateLine(
      { description: 'Steel pipe', quantity: '2', unitPricePaise: 50_000n, taxRatePercent: 18 },
      'intra_state',
    );
    expect(line.grossAmountPaise).toBe(100_000n); // ₹1,000
    expect(line.taxableAmountPaise).toBe(100_000n);
    expect(line.cgstPaise).toBe(9_000n); // 9%
    expect(line.sgstPaise).toBe(9_000n); // 9%
    expect(line.igstPaise).toBe(0n);
    expect(line.lineTotalPaise).toBe(118_000n); // ₹1,180
  });

  it('computes an inter-state line with IGST only', () => {
    const line = calculateLine(
      { description: 'Steel pipe', quantity: '2', unitPricePaise: 50_000n, taxRatePercent: 18 },
      'inter_state',
    );
    expect(line.cgstPaise).toBe(0n);
    expect(line.sgstPaise).toBe(0n);
    expect(line.igstPaise).toBe(18_000n);
    expect(line.lineTotalPaise).toBe(118_000n);
  });

  it('applies a discount before tax', () => {
    const line = calculateLine(
      {
        description: 'Discounted item',
        quantity: '1',
        unitPricePaise: 100_000n,
        discountPercent: 10,
        taxRatePercent: 18,
      },
      'intra_state',
    );
    expect(line.discountPaise).toBe(10_000n);
    expect(line.taxableAmountPaise).toBe(90_000n);
    expect(line.cgstPaise).toBe(8_100n);
    expect(line.sgstPaise).toBe(8_100n);
    expect(line.lineTotalPaise).toBe(106_200n);
  });

  it('handles fractional quantities exactly', () => {
    const line = calculateLine(
      { description: 'Cement', quantity: '2.5', unitPricePaise: 40_000n, taxRatePercent: 28 },
      'intra_state',
    );
    expect(line.grossAmountPaise).toBe(100_000n);
    expect(line.cgstPaise).toBe(14_000n);
    expect(line.sgstPaise).toBe(14_000n);
    expect(line.lineTotalPaise).toBe(128_000n);
  });

  it('supports cess', () => {
    const line = calculateLine(
      {
        description: 'Luxury item',
        quantity: '1',
        unitPricePaise: 100_000n,
        taxRatePercent: 28,
        cessRatePercent: 12,
      },
      'intra_state',
    );
    expect(line.cessPaise).toBe(12_000n);
    expect(line.lineTotalPaise).toBe(140_000n);
  });

  it('supports exempt lines', () => {
    const line = calculateLine(
      { description: 'Exempt goods', quantity: '1', unitPricePaise: 100_000n, taxRatePercent: 0 },
      'exempt',
    );
    expect(line.lineTotalPaise).toBe(100_000n);
  });

  it('rejects a zero quantity and negative price', () => {
    expect(() =>
      calculateLine({ description: 'x', quantity: '0', unitPricePaise: 100n }, 'intra_state'),
    ).toThrow(InvoiceCalculationError);
    expect(() =>
      calculateLine({ description: 'x', quantity: '1', unitPricePaise: -1n }, 'intra_state'),
    ).toThrow(InvoiceCalculationError);
  });

  it('rejects a discount above 100%', () => {
    expect(() =>
      calculateLine(
        { description: 'x', quantity: '1', unitPricePaise: 100n, discountPercent: 101 },
        'intra_state',
      ),
    ).toThrow(InvoiceCalculationError);
  });
});

describe('calculateInvoiceTotals', () => {
  it('sums lines exactly and never rounds the aggregate separately', () => {
    const totals = calculateInvoiceTotals(
      [
        { description: 'A', quantity: '1', unitPricePaise: 33_333n, taxRatePercent: 18 },
        { description: 'B', quantity: '1', unitPricePaise: 33_333n, taxRatePercent: 18 },
        { description: 'C', quantity: '1', unitPricePaise: 33_334n, taxRatePercent: 18 },
      ],
      'intra_state',
    );
    const lineSum = totals.lines.reduce((sum, line) => sum + line.lineTotalPaise, 0n);
    expect(totals.totalAmountPaise).toBe(lineSum);
    expect(totals.taxableAmountPaise).toBe(100_000n);
  });

  it('matches a hand calculation for a mixed-rate invoice', () => {
    // Line 1: 10 × ₹250 @ 18% = ₹2,500 taxable, ₹225 CGST, ₹225 SGST -> ₹2,950
    // Line 2: 2 × ₹1,000 @ 12% with 10% discount = ₹1,800 taxable, ₹108 + ₹108 -> ₹2,016
    // Line 3: 5 × ₹100 @ 5% = ₹500 taxable, ₹12.50 + ₹12.50 -> ₹525
    const totals = calculateInvoiceTotals(
      [
        { description: 'Item 1', quantity: '10', unitPricePaise: 25_000n, taxRatePercent: 18 },
        {
          description: 'Item 2',
          quantity: '2',
          unitPricePaise: 100_000n,
          discountPercent: 10,
          taxRatePercent: 12,
        },
        { description: 'Item 3', quantity: '5', unitPricePaise: 10_000n, taxRatePercent: 5 },
      ],
      'intra_state',
    );

    expect(totals.subtotalPaise).toBe(250_000n + 200_000n + 50_000n);
    expect(totals.discountPaise).toBe(20_000n);
    expect(totals.taxableAmountPaise).toBe(250_000n + 180_000n + 50_000n);
    expect(totals.cgstPaise).toBe(22_500n + 10_800n + 1_250n);
    expect(totals.sgstPaise).toBe(22_500n + 10_800n + 1_250n);
    expect(totals.totalTaxPaise).toBe(69_100n);
    expect(totals.totalAmountPaise).toBe(480_000n + 69_100n);
  });

  it('produces IGST-only totals for inter-state supply', () => {
    const totals = calculateInvoiceTotals(
      [{ description: 'Item', quantity: '1', unitPricePaise: 100_000n, taxRatePercent: 18 }],
      'inter_state',
    );
    expect(totals.cgstPaise).toBe(0n);
    expect(totals.sgstPaise).toBe(0n);
    expect(totals.igstPaise).toBe(18_000n);
    expect(totals.totalAmountPaise).toBe(118_000n);
  });

  it('requires at least one line', () => {
    expect(() => calculateInvoiceTotals([], 'intra_state')).toThrow(InvoiceCalculationError);
  });

  it('keeps totals stable across 100 randomised invoices', () => {
    // Deterministic pseudo-random generator so failures are reproducible.
    let seed = 42;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };

    for (let i = 0; i < 100; i += 1) {
      const lineCount = 1 + Math.floor(rand() * 5);
      const lines = Array.from({ length: lineCount }, (_, index) => ({
        description: `Line ${index}`,
        quantity: (1 + Math.floor(rand() * 20)).toString(),
        unitPricePaise: BigInt(1 + Math.floor(rand() * 500_000)),
        taxRatePercent: [0, 5, 12, 18, 28][Math.floor(rand() * 5)]!,
        discountPercent: Math.floor(rand() * 3) === 0 ? Math.floor(rand() * 20) : 0,
      }));

      const totals = calculateInvoiceTotals(lines, 'intra_state');
      const lineSum = totals.lines.reduce((sum, line) => sum + line.lineTotalPaise, 0n);
      expect(totals.totalAmountPaise).toBe(lineSum);
      expect(totals.totalAmountPaise).toBe(
        totals.taxableAmountPaise + totals.cgstPaise + totals.sgstPaise + totals.igstPaise + totals.cessPaise,
      );
      // CGST + SGST must equal the full tax rate on the taxable value.
      for (const line of totals.lines) {
        const fullTax = (line.taxableAmountPaise * line.taxRateBasisPoints) / 10_000n;
        const splitTax = line.cgstPaise + line.sgstPaise;
        expect(splitTax - fullTax <= 1n && fullTax - splitTax <= 1n).toBe(true);
      }
    }
  });
});

describe('calculateOutstanding', () => {
  it('subtracts allocations', () => {
    expect(calculateOutstanding(500_000n, 100_000n)).toBe(400_000n);
    expect(calculateOutstanding(500_000n, 500_000n)).toBe(0n);
  });

  it('never returns a negative balance', () => {
    expect(calculateOutstanding(500_000n, 600_000n)).toBe(0n);
  });

  it('accounts for adjustments', () => {
    expect(calculateOutstanding(500_000n, 100_000n, 50_000n)).toBe(350_000n);
  });

  it('detects full payment', () => {
    expect(isFullyPaid(500_000n, 500_000n)).toBe(true);
    expect(isFullyPaid(500_000n, 499_999n)).toBe(false);
  });
});
