import { describe, expect, it } from 'vitest';
import {
  MAX_AMOUNT_PAISE,
  MoneyParseError,
  basisPointsToPercent,
  clampToZero,
  formatPaise,
  formatPaiseCompact,
  isValidPaise,
  multiplyPaise,
  paiseToRupeeString,
  paiseToString,
  parsePaise,
  parseRupeesToPaise,
  percentOfPaise,
  percentToBasisPoints,
  sumPaise,
  tryParseRupeesToPaise,
} from '@/lib/money';

describe('parseRupeesToPaise', () => {
  it('parses whole rupees', () => {
    expect(parseRupeesToPaise('1')).toBe(100n);
    expect(parseRupeesToPaise('1000')).toBe(100_000n);
  });

  it('parses decimals exactly', () => {
    expect(parseRupeesToPaise('1000.50')).toBe(100_050n);
    expect(parseRupeesToPaise('0.01')).toBe(1n);
    expect(parseRupeesToPaise('0.1')).toBe(10n);
    expect(parseRupeesToPaise('1000.5')).toBe(100_050n);
  });

  it('avoids binary floating point drift', () => {
    // 0.1 + 0.2 !== 0.3 in floats; here each value is parsed independently.
    expect(parseRupeesToPaise('0.1') + parseRupeesToPaise('0.2')).toBe(parseRupeesToPaise('0.3'));
    // 4.35 is a classic float trap (4.35 * 100 = 434.99999999999994)
    expect(parseRupeesToPaise('4.35')).toBe(435n);
    expect(parseRupeesToPaise('1.15')).toBe(115n);
  });

  it('accepts Indian grouping, currency symbol and whitespace', () => {
    expect(parseRupeesToPaise('₹1,45,000')).toBe(14_500_000n);
    expect(parseRupeesToPaise(' 1,000.50 ')).toBe(100_050n);
    expect(parseRupeesToPaise('1,00,00,000')).toBe(1_000_000_000n);
  });

  it('accepts negative amounts (used for reversals)', () => {
    expect(parseRupeesToPaise('-250.75')).toBe(-25_075n);
  });

  it('rejects invalid input', () => {
    expect(() => parseRupeesToPaise('')).toThrow(MoneyParseError);
    expect(() => parseRupeesToPaise('abc')).toThrow(MoneyParseError);
    expect(() => parseRupeesToPaise('1.234')).toThrow(MoneyParseError);
    expect(() => parseRupeesToPaise('1.2.3')).toThrow(MoneyParseError);
    expect(() => parseRupeesToPaise('1e5')).toThrow(MoneyParseError);
    expect(() => parseRupeesToPaise('--5')).toThrow(MoneyParseError);
    expect(() => parseRupeesToPaise(Number.NaN)).toThrow(MoneyParseError);
    expect(() => parseRupeesToPaise(Number.POSITIVE_INFINITY)).toThrow(MoneyParseError);
  });

  it('tryParse returns null instead of throwing', () => {
    expect(tryParseRupeesToPaise('nope')).toBeNull();
    expect(tryParseRupeesToPaise('12.34')).toBe(1234n);
  });
});

describe('formatPaise', () => {
  it('formats with Indian digit grouping', () => {
    expect(formatPaise(14_500_000n)).toBe('₹1,45,000.00');
    expect(formatPaise(100_000n)).toBe('₹1,000.00');
    expect(formatPaise(100_000_000_00n)).toBe('₹10,00,00,000.00');
  });

  it('formats paise and zero', () => {
    expect(formatPaise(1n)).toBe('₹0.01');
    expect(formatPaise(0n)).toBe('₹0.00');
    expect(formatPaise(100_050n)).toBe('₹1,000.50');
  });

  it('formats negatives', () => {
    expect(formatPaise(-100_050n)).toBe('-₹1,000.50');
  });

  it('can hide decimals', () => {
    expect(formatPaise(14_500_000n, { showDecimals: false })).toBe('₹1,45,000');
  });

  it('round-trips through paiseToRupeeString', () => {
    for (const value of [0n, 1n, 99n, 100n, 100_050n, 14_500_000n, 999_999_999n]) {
      expect(parseRupeesToPaise(paiseToRupeeString(value))).toBe(value);
    }
  });
});

describe('formatPaiseCompact', () => {
  it('uses Indian lakh/crore suffixes', () => {
    expect(formatPaiseCompact(14_500_000n)).toBe('₹1.4L');
    expect(formatPaiseCompact(100_000_000_00n)).toBe('₹10Cr');
    expect(formatPaiseCompact(4_500_000n)).toBe('₹45K');
    expect(formatPaiseCompact(50_000n)).toBe('₹500');
  });
});

describe('sumPaise / clampToZero / isValidPaise', () => {
  it('sums exactly', () => {
    expect(sumPaise([100n, 200n, 300n])).toBe(600n);
    expect(sumPaise([])).toBe(0n);
  });

  it('clamps negatives to zero', () => {
    expect(clampToZero(-1n)).toBe(0n);
    expect(clampToZero(5n)).toBe(5n);
  });

  it('validates range', () => {
    expect(isValidPaise(MAX_AMOUNT_PAISE)).toBe(true);
    expect(isValidPaise(MAX_AMOUNT_PAISE + 1n)).toBe(false);
  });
});

describe('parsePaise', () => {
  it('parses Postgres numeric strings', () => {
    expect(parsePaise('100050')).toBe(100_050n);
    expect(parsePaise('-5')).toBe(-5n);
  });

  it('rejects non-integers', () => {
    expect(() => parsePaise('100.5')).toThrow(MoneyParseError);
    expect(() => parsePaise(1.5)).toThrow(MoneyParseError);
  });

  it('serialises back to a string', () => {
    expect(paiseToString(100_050n)).toBe('100050');
  });
});

describe('multiplyPaise / percentOfPaise', () => {
  it('multiplies with half-up rounding', () => {
    expect(multiplyPaise(100_000n, 18n, 100n)).toBe(18_000n);
    // 333 * 1/3 = 111 exactly
    expect(multiplyPaise(333n, 1n, 3n)).toBe(111n);
    // 100 * 1/3 = 33.33 -> 33
    expect(multiplyPaise(100n, 1n, 3n)).toBe(33n);
    // 101 * 1/3 = 33.67 -> 34 (half-up)
    expect(multiplyPaise(101n, 1n, 3n)).toBe(34n);
  });

  it('handles negative values symmetrically', () => {
    expect(multiplyPaise(-101n, 1n, 3n)).toBe(-34n);
  });

  it('computes percentages', () => {
    expect(percentOfPaise(100_000n, 18)).toBe(18_000n);
    expect(percentOfPaise(100_000n, '2.5')).toBe(2_500n);
    expect(percentOfPaise(100_000n, 0)).toBe(0n);
  });

  it('rejects a zero denominator', () => {
    expect(() => multiplyPaise(1n, 1n, 0n)).toThrow(MoneyParseError);
  });
});

describe('percentToBasisPoints', () => {
  it('converts percentages to basis points', () => {
    expect(percentToBasisPoints(18)).toBe(1800n);
    expect(percentToBasisPoints('18')).toBe(1800n);
    expect(percentToBasisPoints('2.5')).toBe(250n);
    expect(percentToBasisPoints('0.25')).toBe(25n);
    expect(percentToBasisPoints(0)).toBe(0n);
  });

  it('rejects invalid percentages', () => {
    expect(() => percentToBasisPoints('abc')).toThrow(MoneyParseError);
    expect(() => percentToBasisPoints('18.555')).toThrow(MoneyParseError);
    expect(() => percentToBasisPoints(-5)).toThrow(MoneyParseError);
  });

  it('round-trips to a display string', () => {
    expect(basisPointsToPercent(1800)).toBe('18');
    expect(basisPointsToPercent(250)).toBe('2.5');
    expect(basisPointsToPercent(25)).toBe('0.25');
  });
});
