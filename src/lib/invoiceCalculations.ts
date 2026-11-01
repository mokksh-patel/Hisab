/**
 * invoiceCalculations.ts — the single source of truth for invoice arithmetic.
 *
 * RULES:
 *  1. Every line is computed in paise with integer arithmetic. No floats.
 *  2. Rounding happens ONCE per line (taxable value, then each tax component).
 *     The invoice total is the exact sum of the rounded line values, so the
 *     printed total always equals the sum of the printed lines.
 *  3. GST split is decided by place of supply vs. supplier state:
 *       intra-state -> CGST + SGST (rate split in half)
 *       inter-state -> IGST (full rate)
 *     Cess is supported as an additional per-line rate.
 *  4. Quantities are exact decimals (up to 3 places) represented as a scaled
 *     integer, never as floating point.
 *  5. Prices may be tax-EXCLUSIVE (default) or tax-INCLUSIVE. Inclusive pricing
 *     back-solves the taxable value so that taxable + tax equals the entered
 *     amount exactly.
 *
 * This module mirrors `public.create_invoice()` in migration 0005. Any change
 * here MUST be mirrored there, and vice versa — the database is the financial
 * source of truth; this module exists for live preview and for tests.
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

/** How a line's discount is expressed. */
export type DiscountType = 'none' | 'percent' | 'fixed';

export interface InvoiceLineInput {
  /** Stable client-side key for React lists. */
  key?: string;
  description: string;
  hsnSac?: string | null;
  /** Quantity as entered by the user, e.g. "2", "1.5", "0.250". */
  quantity: string;
  unit?: string | null;
  /** Unit price in paise. Tax-inclusive when `priceIncludesTax` is true. */
  unitPricePaise: Paise;
  /** Discount as a percentage (0–100, up to 2 decimals). */
  discountPercent?: string | number;
  /** Discount as a fixed amount in paise. Mutually exclusive with percent. */
  discountFixedPaise?: Paise;
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
  /** True when `unitPricePaise` already included tax. */
  priceIncludesTax: boolean;
  /** unit price × quantity, before any discount. */
  grossAmountPaise: Paise;
  discountType: DiscountType;
  discountPaise: Paise;
  /** Value on which tax is computed. */
  taxableAmountPaise: Paise;
  taxRateBasisPoints: bigint;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  cessPaise: Paise;
  /** taxable + all tax components. */
  lineTotalPaise: Paise;
}

export interface InvoiceTotals {
  lines: InvoiceLineTotals[];
  /** Sum of gross line amounts before discount. */
  subtotalPaise: Paise;
  /** Sum of item-level discounts. */
  itemDiscountPaise: Paise;
  /** Invoice-level discount actually applied (never exceeds the taxable base). */
  invoiceDiscountPaise: Paise;
  /** Total discount = item + invoice level. */
  discountPaise: Paise;
  taxableAmountPaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  cessPaise: Paise;
  totalTaxPaise: Paise;
  totalAmountPaise: Paise;
  gstMode: GstMode;
  priceIncludesTax: boolean;
}

export interface InvoiceOptions {
  /** When true, unit prices are treated as tax-inclusive. */
  priceIncludesTax?: boolean;
  /** Invoice-level discount in paise, applied proportionally across lines. */
  invoiceDiscountPaise?: Paise;
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
 *
 * IMPORTANT: this is a *suggestion*, not an authority. When either state code
 * is missing the correct behaviour is to ask the user, not to guess. Callers
 * should surface `placeOfSupplyWarning()` rather than silently accepting the
 * fallback.
 */
export function resolveGstMode(
  supplierStateCode: string | null | undefined,
  placeOfSupplyStateCode: string | null | undefined,
): GstMode {
  if (!supplierStateCode || !placeOfSupplyStateCode) return 'intra_state';
  return supplierStateCode === placeOfSupplyStateCode ? 'intra_state' : 'inter_state';
}

/**
 * Returns a human-readable warning when the GST treatment cannot be determined
 * from the available data, or null when it is unambiguous.
 *
 * This exists because silently defaulting to intra-state can produce a legally
 * incorrect tax invoice. The UI must show this warning.
 */
export function placeOfSupplyWarning(
  supplierStateCode: string | null | undefined,
  placeOfSupplyStateCode: string | null | undefined,
  gstMode: GstMode,
): string | null {
  if (gstMode === 'exempt') return null;
  if (!supplierStateCode) {
    return 'Your business state is not set. GST treatment cannot be determined — set it in Settings.';
  }
  if (!placeOfSupplyStateCode) {
    return 'Place of supply is not set. GST treatment cannot be determined — select the customer state.';
  }
  return null;
}

/** Resolve which discount type a line uses. Percent wins if both are supplied. */
function resolveDiscountType(line: InvoiceLineInput): DiscountType {
  const hasPercent =
    line.discountPercent !== undefined &&
    line.discountPercent !== null &&
    String(line.discountPercent).trim() !== '' &&
    String(line.discountPercent).trim() !== '0';
  if (hasPercent) return 'percent';
  if (line.discountFixedPaise !== undefined && line.discountFixedPaise > 0n) return 'fixed';
  return 'none';
}

/**
 * Compute a single invoice line.
 *
 * Tax-exclusive (default):
 *   gross    = price × qty
 *   discount = gross × rate   (or the fixed amount)
 *   taxable  = gross − discount
 *   tax      = taxable × rate
 *   total    = taxable + tax
 *
 * Tax-inclusive:
 *   gross    = price × qty            (this is what the customer pays)
 *   discount = gross × rate           (or the fixed amount)
 *   net      = gross − discount       (still tax-inclusive)
 *   taxable  = net × 10000 / (10000 + taxRate + cessRate)
 *   tax      = net − taxable          (exact, so taxable + tax === net)
 *
 * The inclusive branch derives tax by subtraction rather than by a second
 * rounding, which guarantees the line reconciles to the entered amount.
 */
export function calculateLine(
  line: InvoiceLineInput,
  gstMode: GstMode,
  priceIncludesTax = false,
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

  const discountType = resolveDiscountType(line);
  let discountPaise = 0n;

  if (discountType === 'percent') {
    const discountBp = percentToBasisPoints(line.discountPercent ?? 0);
    if (discountBp < 0n || discountBp > 10_000n) {
      throw new InvoiceCalculationError('Discount must be between 0 and 100 percent');
    }
    discountPaise = multiplyPaise(grossAmountPaise, discountBp, 10_000n);
  } else if (discountType === 'fixed') {
    discountPaise = line.discountFixedPaise ?? 0n;
    if (discountPaise < 0n) {
      throw new InvoiceCalculationError('Discount cannot be negative');
    }
    if (discountPaise > grossAmountPaise) {
      throw new InvoiceCalculationError('Discount cannot exceed the line amount');
    }
  }

  const taxRateBasisPoints = percentToBasisPoints(line.taxRatePercent ?? 0);
  const cessBp = percentToBasisPoints(line.cessRatePercent ?? 0);

  // The amount after discount. For exclusive pricing this is the taxable value;
  // for inclusive pricing it still contains tax.
  const netPaise = grossAmountPaise - discountPaise;

  let taxableAmountPaise: Paise;
  let cgstPaise = 0n;
  let sgstPaise = 0n;
  let igstPaise = 0n;
  let cessPaise = 0n;

  if (priceIncludesTax) {
    // Back-solve the taxable value from the tax-inclusive net amount.
    const totalRateBp = taxRateBasisPoints + cessBp;
    if (totalRateBp === 0n) {
      taxableAmountPaise = netPaise;
    } else {
      // taxable = net × 10000 / (10000 + rate)
      taxableAmountPaise = multiplyPaise(netPaise, 10_000n, 10_000n + totalRateBp);
    }

    // Derive the tax by subtraction so taxable + tax === net exactly.
    const totalTaxPaise = netPaise - taxableAmountPaise;

    if (gstMode === 'exempt' || totalRateBp === 0n) {
      // No tax to split; any residual belongs to the taxable value.
      taxableAmountPaise = netPaise;
    } else if (gstMode === 'inter_state') {
      // Split the derived tax between IGST and cess by their rate shares.
      cessPaise = multiplyPaise(totalTaxPaise, cessBp, totalRateBp);
      igstPaise = totalTaxPaise - cessPaise;
    } else {
      // intra_state: split the GST portion into CGST/SGST, keep cess separate.
      const gstPortion = multiplyPaise(totalTaxPaise, taxRateBasisPoints, totalRateBp);
      cessPaise = totalTaxPaise - gstPortion;

      const halfBp = taxRateBasisPoints / 2n;
      const remainderBp = taxRateBasisPoints - halfBp;
      cgstPaise = multiplyPaise(gstPortion, halfBp, taxRateBasisPoints);
      sgstPaise = gstPortion - cgstPaise;
      // `remainderBp` is intentionally unused: SGST is derived by subtraction so
      // CGST + SGST always equals the GST portion exactly.
      void remainderBp;
    }
  } else {
    taxableAmountPaise = netPaise;

    if (gstMode === 'inter_state') {
      igstPaise = multiplyPaise(taxableAmountPaise, taxRateBasisPoints, 10_000n);
    } else if (gstMode === 'intra_state') {
      // Split the rate in half first so CGST + SGST always equals the full rate.
      const halfBp = taxRateBasisPoints / 2n;
      const remainderBp = taxRateBasisPoints - halfBp;
      cgstPaise = multiplyPaise(taxableAmountPaise, halfBp, 10_000n);
      sgstPaise = multiplyPaise(taxableAmountPaise, remainderBp, 10_000n);
    }

    cessPaise = multiplyPaise(taxableAmountPaise, cessBp, 10_000n);
  }

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
    priceIncludesTax,
    grossAmountPaise,
    discountType,
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
 * Allocate an invoice-level discount across lines in proportion to their
 * taxable value, distributing any rounding remainder to the largest line so the
 * allocation always sums exactly to the requested discount.
 *
 * Returns one allocation per line, in the same order as `lines`.
 */
export function allocateInvoiceDiscount(
  lines: readonly InvoiceLineTotals[],
  invoiceDiscountPaise: Paise,
): Paise[] {
  if (invoiceDiscountPaise <= 0n || lines.length === 0) {
    return lines.map(() => 0n);
  }

  const base = sumPaise(lines.map((line) => line.taxableAmountPaise));
  if (base <= 0n) {
    throw new InvoiceCalculationError('Cannot apply an invoice discount to a zero-value invoice');
  }
  if (invoiceDiscountPaise > base) {
    throw new InvoiceCalculationError('Invoice discount cannot exceed the taxable value');
  }

  const allocations = lines.map((line) =>
    multiplyPaise(invoiceDiscountPaise, line.taxableAmountPaise, base),
  );

  // Distribute the rounding remainder to the line with the largest taxable value.
  const allocated = sumPaise(allocations);
  const remainder = invoiceDiscountPaise - allocated;
  if (remainder !== 0n) {
    let largestIndex = 0;
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i]!.taxableAmountPaise > lines[largestIndex]!.taxableAmountPaise) largestIndex = i;
    }
    allocations[largestIndex] = allocations[largestIndex]! + remainder;
  }

  return allocations;
}

/**
 * Compute all invoice totals.
 *
 * The invoice total is the exact sum of the rounded line totals — never a
 * separately rounded aggregate. An invoice-level discount is allocated across
 * lines proportionally to taxable value, and each line's tax is recomputed on
 * its reduced taxable value so the tax breakdown stays correct.
 */
export function calculateInvoiceTotals(
  lines: readonly InvoiceLineInput[],
  gstMode: GstMode,
  options: InvoiceOptions = {},
): InvoiceTotals {
  if (lines.length === 0) {
    throw new InvoiceCalculationError('An invoice needs at least one line item');
  }

  const priceIncludesTax = options.priceIncludesTax ?? false;
  const invoiceDiscountPaise = options.invoiceDiscountPaise ?? 0n;

  const computed = lines.map((line) => calculateLine(line, gstMode, priceIncludesTax));

  const subtotalPaise = sumPaise(computed.map((l) => l.grossAmountPaise));
  const itemDiscountPaise = sumPaise(computed.map((l) => l.discountPaise));

  // Apply the invoice-level discount by reducing each line's taxable value and
  // recomputing its tax on the reduced base.
  let finalLines = computed;
  let appliedInvoiceDiscount = 0n;

  if (invoiceDiscountPaise > 0n) {
    const allocations = allocateInvoiceDiscount(computed, invoiceDiscountPaise);
    appliedInvoiceDiscount = sumPaise(allocations);

    finalLines = computed.map((line, index) => {
      const reduction = allocations[index]!;
      if (reduction === 0n) return line;

      const newTaxable = line.taxableAmountPaise - reduction;
      const totalRateBp = line.taxRateBasisPoints;

      let cgst = 0n;
      let sgst = 0n;
      let igst = 0n;

      if (gstMode === 'inter_state') {
        igst = multiplyPaise(newTaxable, totalRateBp, 10_000n);
      } else if (gstMode === 'intra_state') {
        const halfBp = totalRateBp / 2n;
        const remainderBp = totalRateBp - halfBp;
        cgst = multiplyPaise(newTaxable, halfBp, 10_000n);
        sgst = multiplyPaise(newTaxable, remainderBp, 10_000n);
      }

      // Cess is recomputed on the reduced base using the original ratio.
      const cess =
        line.taxableAmountPaise > 0n
          ? multiplyPaise(line.cessPaise, newTaxable, line.taxableAmountPaise)
          : 0n;

      return {
        ...line,
        taxableAmountPaise: newTaxable,
        cgstPaise: cgst,
        sgstPaise: sgst,
        igstPaise: igst,
        cessPaise: cess,
        lineTotalPaise: newTaxable + cgst + sgst + igst + cess,
      };
    });
  }

  const taxableAmountPaise = sumPaise(finalLines.map((l) => l.taxableAmountPaise));
  const cgstPaise = sumPaise(finalLines.map((l) => l.cgstPaise));
  const sgstPaise = sumPaise(finalLines.map((l) => l.sgstPaise));
  const igstPaise = sumPaise(finalLines.map((l) => l.igstPaise));
  const cessPaise = sumPaise(finalLines.map((l) => l.cessPaise));
  const totalTaxPaise = cgstPaise + sgstPaise + igstPaise + cessPaise;
  const totalAmountPaise = taxableAmountPaise + totalTaxPaise;

  return {
    lines: finalLines,
    subtotalPaise,
    itemDiscountPaise,
    invoiceDiscountPaise: appliedInvoiceDiscount,
    discountPaise: itemDiscountPaise + appliedInvoiceDiscount,
    taxableAmountPaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    cessPaise,
    totalTaxPaise,
    totalAmountPaise,
    gstMode,
    priceIncludesTax,
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
