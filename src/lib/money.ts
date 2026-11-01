/**
 * money.ts — exact monetary arithmetic for BizPilot.
 *
 * RULES (non-negotiable):
 *  1. Money is ALWAYS stored and computed as whole paise (1 rupee = 100 paise).
 *  2. Paise are represented as `bigint` in TypeScript and NUMERIC(20,0) in Postgres.
 *  3. Floating point is never used for money. Rupee input is parsed from its
 *     decimal *string* form, never via `parseFloat`.
 *  4. Values crossing the network boundary are strings (Postgres numeric comes
 *     back as a string; JSON numbers would lose precision above 2^53).
 *
 * ₹1 = 100 paise. ₹1,000.50 = 100050 paise.
 */

export const PAISE_PER_RUPEE = 100n;

/** Maximum amount accepted by the UI: ₹10,00,00,00,000 (one thousand crore). */
export const MAX_AMOUNT_PAISE = 1_000_000_000_000n;

export type Paise = bigint;

export class MoneyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyParseError';
  }
}

const RUPEE_INPUT_RE = /^-?\d{1,15}(\.\d{0,2})?$/;

/**
 * Parse user-entered rupees into paise using exact string arithmetic.
 *
 * Accepts: "1000", "1000.5", "1000.50", "1,000.50", "₹1,000.50", " 1000 ".
 * Rejects: "", "abc", "1.234" (more than 2 decimals), "1e5", "1.2.3".
 *
 * @throws MoneyParseError when the input is not a valid rupee amount.
 */
export function parseRupeesToPaise(input: string | number): Paise {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new MoneyParseError('Amount must be a finite number');
    // Convert through the shortest round-trip decimal representation, then
    // parse that string exactly. This avoids binary floating point drift.
    input = String(input);
  }

  const cleaned = input
    .trim()
    .replace(/[\u20B9\u00A0\s]/g, '') // ₹, non-breaking space, whitespace
    .replace(/,/g, ''); // Indian or western grouping separators

  if (cleaned === '') throw new MoneyParseError('Amount is required');
  if (!RUPEE_INPUT_RE.test(cleaned)) {
    throw new MoneyParseError('Enter a valid amount with at most 2 decimal places');
  }

  const negative = cleaned.startsWith('-');
  const unsigned = negative ? cleaned.slice(1) : cleaned;
  const [wholePart = '0', fractionPart = ''] = unsigned.split('.');
  const fraction = (fractionPart + '00').slice(0, 2);
  const paise = BigInt(wholePart) * PAISE_PER_RUPEE + BigInt(fraction);

  return negative ? -paise : paise;
}

/** Like {@link parseRupeesToPaise} but returns `null` instead of throwing. */
export function tryParseRupeesToPaise(input: string | number): Paise | null {
  try {
    return parseRupeesToPaise(input);
  } catch {
    return null;
  }
}

/**
 * Convert paise to a plain rupee string with exactly two decimals, e.g.
 * 100050n -> "1000.50". Suitable for form inputs and CSV export.
 */
export function paiseToRupeeString(paise: Paise): string {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const whole = abs / PAISE_PER_RUPEE;
  const fraction = abs % PAISE_PER_RUPEE;
  return `${negative ? '-' : ''}${whole.toString()}.${fraction.toString().padStart(2, '0')}`;
}

/**
 * Format paise for display using Indian digit grouping.
 * 14500000n -> "₹1,45,000.00"
 *
 * Uses `Intl.NumberFormat` on the exact rupee string so no precision is lost.
 */
export function formatPaise(paise: Paise, options: { showDecimals?: boolean } = {}): string {
  const { showDecimals = true } = options;
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const whole = abs / PAISE_PER_RUPEE;
  const fraction = abs % PAISE_PER_RUPEE;

  const grouped = new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 0,
    useGrouping: true,
  }).format(whole);

  const decimals = showDecimals ? `.${fraction.toString().padStart(2, '0')}` : '';
  return `${negative ? '-' : ''}₹${grouped}${decimals}`;
}

/**
 * Compact display for KPI cards: ₹1.45L, ₹2.30Cr, ₹45,000.
 * Only used for presentation; never for arithmetic.
 */
export function formatPaiseCompact(paise: Paise): string {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const sign = negative ? '-' : '';
  const crore = 10_000_000n * PAISE_PER_RUPEE;
  const lakh = 100_000n * PAISE_PER_RUPEE;
  const thousand = 1_000n * PAISE_PER_RUPEE;

  const withSuffix = (divisor: bigint, suffix: string) => {
    // One decimal place, computed with integer arithmetic.
    const tenths = (abs * 10n) / divisor;
    const whole = tenths / 10n;
    const frac = tenths % 10n;
    return `${sign}₹${whole.toString()}${frac === 0n ? '' : `.${frac.toString()}`}${suffix}`;
  };

  if (abs >= crore) return withSuffix(crore, 'Cr');
  if (abs >= lakh) return withSuffix(lakh, 'L');
  if (abs >= thousand) return withSuffix(thousand, 'K');
  return formatPaise(paise, { showDecimals: false });
}

/** Sum a list of paise values exactly. */
export function sumPaise(values: readonly Paise[]): Paise {
  return values.reduce<Paise>((total, value) => total + value, 0n);
}

/** Clamp a paise value to zero — balances must never be negative. */
export function clampToZero(paise: Paise): Paise {
  return paise < 0n ? 0n : paise;
}

/** True when the value is a whole number of paise within the accepted range. */
export function isValidPaise(value: Paise): boolean {
  return value >= -MAX_AMOUNT_PAISE && value <= MAX_AMOUNT_PAISE;
}

/**
 * Parse a paise value coming from Postgres (numeric arrives as a string) or
 * from JSON. Throws when the value is not an integer.
 */
export function parsePaise(value: string | number | bigint): Paise {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new MoneyParseError(`Paise must be an integer, received ${value}`);
    }
    return BigInt(value);
  }
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new MoneyParseError(`Paise must be an integer string, received "${value}"`);
  }
  return BigInt(trimmed);
}

/** Serialise paise for the database / JSON boundary. */
export function paiseToString(paise: Paise): string {
  return paise.toString();
}

/**
 * Multiply paise by a rational factor using half-up rounding at the paise
 * level. Used for tax and discount calculations.
 *
 * Example: 100000n * 18/100 = 18000n (18% of ₹1,000).
 */
export function multiplyPaise(paise: Paise, numerator: bigint, denominator: bigint): Paise {
  if (denominator === 0n) throw new MoneyParseError('Denominator must not be zero');
  const product = paise * numerator;
  const negative = product < 0n;
  const abs = negative ? -product : product;
  const quotient = abs / denominator;
  const remainder = abs % denominator;
  // Half-up rounding on the absolute value, then re-apply the sign.
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** Percentage helper: `percentOfPaise(100000n, 18)` -> 18000n. */
export function percentOfPaise(paise: Paise, percent: number | string): Paise {
  const basisPoints = percentToBasisPoints(percent);
  return multiplyPaise(paise, basisPoints, 10_000n);
}

/**
 * Convert a percentage (e.g. 18, "18", "2.5") into basis points (1800, 250).
 * Basis points keep tax rates exact: 1 bp = 0.01%.
 */
export function percentToBasisPoints(percent: number | string): bigint {
  const raw = typeof percent === 'number' ? String(percent) : percent.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw)) {
    throw new MoneyParseError(`Invalid percentage: "${percent}"`);
  }
  const [whole = '0', fraction = ''] = raw.split('.');
  const padded = (fraction + '00').slice(0, 2);
  return BigInt(whole) * 100n + BigInt(padded);
}

/** Convert basis points back to a display percentage string ("1800" -> "18"). */
export function basisPointsToPercent(basisPoints: number | bigint): string {
  const bp = typeof basisPoints === 'bigint' ? basisPoints : BigInt(basisPoints);
  const whole = bp / 100n;
  const fraction = bp % 100n;
  if (fraction === 0n) return whole.toString();
  return `${whole.toString()}.${fraction.toString().padStart(2, '0').replace(/0$/, '')}`;
}
