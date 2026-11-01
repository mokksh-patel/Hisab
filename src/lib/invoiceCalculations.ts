/**
 * invoiceCalculations.ts — the single source of truth for invoice arithmetic.
 *
 * RULES:
 *  1. Every line is computed in paise with integer arithmetic.
 *  2. Rounding happens ONCE per line (taxable value, then each tax component).
 *     The invoice total is the exact sum of the rounded line values, so the
 *     printed total always equals the sum of the printed lines.
 *  3. GST split is decided by place of supply vs. supplier state:
 *       intra-state -> CGST + SGST (rate split in half)
 *       inter-state -> IGST (full rate)
 *     Cess is supported as an additional per-line rate.
 *  4. Quantities are exact decimals (up to 3 places) represented as a scaled
 *     integer, never as floating point.
 */

import {
  type Paise,
  multiplyPaise,
  percentToBasisPoints,
  sumPaise,
} from './money';

/** Quantity scaled by 1000 (3 decimal places), e.g. 1.5 -> 1500n. */
export type ScaledQuantity = bigint;

export const QUANTITY_SCALE = 1000n;

export type GstMode = 'intra_state' | 'inter_state' | 'exempt';

export interface InvoiceLineInput {
  /** Stable client-side key for React lists. */
  key?: string;
  description: string;
  hsnSac?: string | null;
  /** Quantity as entered by the user, e.g. "2", "1.5", "0.250". */
  quantity: string;
  unit?: string | null;
  /** Unit price in paise. */
  unitPricePaise: Paise;
  /** Discount percentage applied to the line (0–100, up to 2 decimals). */
  discountPercent?: string | number;
  /** GST rate percentage, e.g. 18, "12", "0.25". */
  taxRatePercent?: string | number;
  /** Compensation cess percentage, if applicable. */
  cessRatePercent?: string | number;
}

export interface InvoiceLineTotals {
  key?: string;
  description: string;
  hsnSac: string | null;
  unit: string | null;
  quantity: string;
  scaledQuantity: ScaledQuantity;
  unitPricePaise: Paise;
  grossAmountPaise: Paise;
  discountPaise: Paise;
  taxableAmountPaise: Paise;
  taxRateBasisPoints: bigint;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  cessPaise: Paise;
  lineTotalPaise: Paise;
}

export interface InvoiceTotals {
  lines: InvoiceLineTotals[];
  subtotalPaise: Paise;
  discountPaise: Paise;
  taxableAmountPaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  cessPaise: Paise;
  totalTaxPaise: Paise;
  totalAmountPaise: Paise;
  gstMode: GstMode;
}

export class InvoiceCalculationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceCalculationError';
  }
}

const QUANTITY_RE = /^\d{1,9}(\.\d{1,3})?$/;

/** Parse a user-entered quantity into a scaled integer (3 decimal places). */
export function parseQuantity(input: string | number): ScaledQuantity {
  const raw = typeof input === 'number' ? String(input) : input.trim();
  if (!QUANTITY_RE.test(raw)) {
    throw new InvoiceCalculationError(`Invalid quantity "${input}"`);
  }
  const [whole = '0', fraction = ''] = raw.split('.');
  const padded = (fraction + '000').slice(0, 3);
  return BigInt(whole) * QUANTITY_SCALE + BigInt(padded);
}

/** Render a scaled quantity back to a trimmed decimal string. */
export function formatQuantity(scaled: ScaledQuantity): string {
  const whole = scaled / QUANTITY_SCALE;
  const fraction = scaled % QUANTITY_SCALE;
  if (fraction === 0n) return whole.toString();
  return `${whole.toString()}.${fraction.toString().padStart(3, '0').replace(/0+$/, '')}`;
}

/**
 * Decide the GST mode from the supplier's state code and the place of supply.
 * When either is missing we fall back to intra-state, which is the conservative
 * choice for a single-state small business (and is always overridable in the UI).
 */
export function resolveGstMode(
  supplierStateCode: string | null | undefined,
  placeOfSupplyStateCode: string | null | undefined,
): GstMode {
  if (!supplierStateCode || !placeOfSupplyStateCode) return 'intra_state';
  return supplierStateCode === placeOfSupplyStateCode ? 'intra_state' : 'inter_state';
}

/** Compute a single invoice line. */
export function calculateLine(
  line: InvoiceLineInput,
  gstMode: GstMode,
): InvoiceLineTotals {
  const scaledQuantity = parseQuantity(line.quantity);
  if (scaledQuantity <= 0n) {
    throw new InvoiceCalculationError('Quantity must be greater than zero');
  }
  if (line.unitPricePaise < 0n) {
    throw new InvoiceCalculationError('Unit price cannot be negative');
  }

  // gross = unit price × quantity, rounded once to the paise.
  const grossAmountPaise = multiplyPaise(line.unitPricePaise, scaledQuantity, QUANTITY_SCALE);

  const discountBp = percentToBasisPoints(line.discountPercent ?? 0);
  if (discountBp < 0n || discountBp > 10_000n) {
    throw new InvoiceCalculationError('Discount must be between 0 and 100 percent');
  }
  const discountPaise = multiplyPaise(grossAmountPaise, discountBp, 10_000n);
  const taxableAmountPaise = grossAmountPaise - discountPaise;

  const taxRateBasisPoints = percentToBasisPoints(line.taxRatePercent ?? 0);
  const cessBp = percentToBasisPoints(line.cessRatePercent ?? 0);

  let cgstPaise = 0n;
  let sgstPaise = 0n;
  let igstPaise = 0n;

  if (gstMode === 'inter_state') {
    igstPaise = multiplyPaise(taxableAmountPaise, taxRateBasisPoints, 10_000n);
  } else if (gstMode === 'intra_state') {
    // Split the rate in half first so CGST + SGST always equals the full rate.
    const halfBp = taxRateBasisPoints / 2n;
    const remainderBp = taxRateBasisPoints - halfBp;
    cgstPaise = multiplyPaise(taxableAmountPaise, halfBp, 10_000n);
    sgstPaise = multiplyPaise(taxableAmountPaise, remainderBp, 10_000n);
  }

  const cessPaise = multiplyPaise(taxableAmountPaise, cessBp, 10_000n);

  const lineTotalPaise =
    taxableAmountPaise + cgstPaise + sgstPaise + igstPaise + cessPaise;

  return {
    key: line.key,
    description: line.description.trim(),
    hsnSac: line.hsnSac?.trim() || null,
    unit: line.unit?.trim() || null,
    quantity: formatQuantity(scaledQuantity),
    scaledQuantity,
    unitPricePaise: line.unitPricePaise,
    grossAmountPaise,
    discountPaise,
    taxableAmountPaise,
    taxRateBasisPoints,
    cgstPaise,
    sgstPaise,
    igstPaise,
    cessPaise,
    lineTotalPaise,
  };
}

/**
 * Compute all invoice totals. The invoice total is the exact sum of the
 * rounded line totals — never a separately rounded aggregate.
 */
export function calculateInvoiceTotals(
  lines: readonly InvoiceLineInput[],
  gstMode: GstMode,
): InvoiceTotals {
  if (lines.length === 0) {
    throw new InvoiceCalculationError('An invoice needs at least one line item');
  }

  const computed = lines.map((line) => calculateLine(line, gstMode));

  const subtotalPaise = sumPaise(computed.map((l) => l.grossAmountPaise));
  const discountPaise = sumPaise(computed.map((l) => l.discountPaise));
  const taxableAmountPaise = sumPaise(computed.map((l) => l.taxableAmountPaise));
  const cgstPaise = sumPaise(computed.map((l) => l.cgstPaise));
  const sgstPaise = sumPaise(computed.map((l) => l.sgstPaise));
  const igstPaise = sumPaise(computed.map((l) => l.igstPaise));
  const cessPaise = sumPaise(computed.map((l) => l.cessPaise));
  const totalTaxPaise = cgstPaise + sgstPaise + igstPaise + cessPaise;
  const totalAmountPaise = taxableAmountPaise + totalTaxPaise;

  return {
    lines: computed,
    subtotalPaise,
    discountPaise,
    taxableAmountPaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    cessPaise,
    totalTaxPaise,
    totalAmountPaise,
    gstMode,
  };
}

/**
 * Outstanding balance for an invoice.
 *   outstanding = total − allocated payments − valid adjustments, floored at 0.
 * A negative result is impossible by construction; we clamp defensively.
 */
export function calculateOutstanding(
  totalAmountPaise: Paise,
  allocatedPaise: Paise,
  adjustmentPaise: Paise = 0n,
): Paise {
  const remaining = totalAmountPaise - allocatedPaise - adjustmentPaise;
  return remaining > 0n ? remaining : 0n;
}

/** True when the invoice has been fully settled. */
export function isFullyPaid(totalAmountPaise: Paise, allocatedPaise: Paise, adjustmentPaise: Paise = 0n): boolean {
  return calculateOutstanding(totalAmountPaise, allocatedPaise, adjustmentPaise) === 0n;
}
