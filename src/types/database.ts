/**
 * database.ts — hand-written types for the BizPilot schema.
 *
 * Money columns are typed as `string` because Postgres `numeric` is returned
 * as a string by PostgREST. Convert with `parsePaise()` from lib/money.ts —
 * never with `Number()`.
 */

export type MemberRole = 'owner' | 'admin' | 'accountant' | 'collection_staff' | 'read_only';
export type InvitationStatus = 'pending' | 'accepted' | 'revoked';
export type DocumentState = 'draft' | 'issued' | 'void';
export type PaymentMethod = 'cash' | 'bank_transfer' | 'upi' | 'cheque' | 'card' | 'other';
export type ChequeStatus = 'not_applicable' | 'pending' | 'cleared' | 'bounced';
export type GstMode = 'intra_state' | 'inter_state' | 'exempt';
/** GST registration category. Composition businesses may not issue tax invoices. */
export type GstScheme = 'unregistered' | 'regular' | 'composition';
/** How an invoice line's discount was entered. */
export type DiscountType = 'none' | 'percent' | 'fixed';

export interface Business {
  id: string;
  legal_name: string;
  display_name: string;
  business_type: string | null;
  gstin: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state_code: string | null;
  postal_code: string | null;
  phone: string | null;
  email: string | null;
  currency: string;
  timezone: string;
  financial_year_start_month: number;
  invoice_prefix: string;
  default_credit_period_days: number;
  default_tax_rate_basis_points: number;
  is_gst_registered: boolean;
  /** GST registration category. Nullable for rows created before migration 0005. */
  gst_scheme: GstScheme | null;
  /** True when the scheme was inferred during migration and needs owner review. */
  gst_scheme_needs_review: boolean;
  reminder_template: string | null;
  created_at: string;
  updated_at: string;
}

export interface Profile {
  id: string;
  full_name: string | null;
  phone: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusinessMember {
  id: string;
  business_id: string;
  user_id: string;
  role: MemberRole;
  invitation_status: InvitationStatus;
  invited_email: string | null;
  created_at: string;
  updated_at: string;
}

export interface Customer {
  id: string;
  business_id: string;
  customer_name: string;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  billing_address: string | null;
  shipping_address: string | null;
  city: string | null;
  state_code: string | null;
  credit_period_days: number;
  credit_limit_paise: string;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Invoice {
  id: string;
  business_id: string;
  customer_id: string;
  invoice_number: string;
  financial_year: string;
  invoice_date: string;
  due_date: string;
  document_state: DocumentState;
  place_of_supply_state_code: string | null;
  gst_mode: GstMode;
  subtotal_paise: string;
  discount_paise: string;
  taxable_amount_paise: string;
  cgst_paise: string;
  sgst_paise: string;
  igst_paise: string;
  cess_paise: string;
  total_tax_paise: string;
  total_amount_paise: string;
  /** True when line unit prices were entered tax-inclusive. */
  price_includes_tax: boolean;
  /** Invoice-level discount. `discount_paise` remains the sum of item discounts. */
  invoice_discount_paise: string;
  customer_snapshot: Record<string, unknown> | null;
  notes: string | null;
  issued_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvoiceItem {
  id: string;
  business_id: string;
  invoice_id: string;
  line_number: number;
  description: string;
  hsn_sac: string | null;
  quantity: string;
  unit: string | null;
  unit_price_paise: string;
  discount_percent_basis_points: number;
  /** How the discount was entered. */
  discount_type: DiscountType;
  /** Raw discount input: basis points for percent, paise for fixed. */
  discount_value: string;
  gross_amount_paise: string;
  discount_paise: string;
  taxable_amount_paise: string;
  tax_rate_basis_points: number;
  /** Compensation cess rate in basis points, as entered. */
  cess_rate_basis_points: number;
  cgst_paise: string;
  sgst_paise: string;
  igst_paise: string;
  cess_paise: string;
  line_total_paise: string;
  created_at: string;
}

export interface Payment {
  id: string;
  business_id: string;
  customer_id: string;
  payment_date: string;
  amount_paise: string;
  payment_method: PaymentMethod;
  reference_number: string | null;
  cheque_status: ChequeStatus;
  notes: string | null;
  idempotency_key: string;
  reversed_at: string | null;
  reversed_by: string | null;
  reversal_reason: string | null;
  reverses_payment_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentAllocation {
  id: string;
  business_id: string;
  payment_id: string;
  invoice_id: string;
  allocated_amount_paise: string;
  created_by: string | null;
  created_at: string;
}

/**
 * Row from the `invoice_item_discounts` view.
 *
 * `effective_*` fields are the values to display: for draft lines they come
 * from the stored columns, for issued (immutable) lines they are derived from
 * `discount_percent_basis_points`.
 */
export interface InvoiceItemDiscount {
  invoice_item_id: string;
  business_id: string;
  invoice_id: string;
  discount_percent_basis_points: number;
  discount_paise: string;
  effective_discount_type: DiscountType;
  effective_discount_value: string;
}

export interface ReminderLog {
  id: string;
  business_id: string;
  customer_id: string;
  invoice_id: string | null;
  channel: string;
  message: string | null;
  sent_at: string;
  created_by: string | null;
  created_at: string;
}

export interface AuditLog {
  id: string;
  business_id: string;
  user_id: string | null;
  entity_type: string;
  entity_id: string | null;
  action: string;
  previous_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface InvoiceBalance {
  invoice_id: string;
  business_id: string;
  customer_id: string;
  invoice_number: string;
  financial_year: string;
  invoice_date: string;
  due_date: string;
  document_state: DocumentState;
  total_amount_paise: string;
  allocated_paise: string;
  outstanding_paise: string;
  issued_at: string | null;
  created_at: string;
}

export interface PaymentBalance {
  payment_id: string;
  business_id: string;
  customer_id: string;
  payment_date: string;
  amount_paise: string;
  payment_method: PaymentMethod;
  reference_number: string | null;
  cheque_status: ChequeStatus;
  reversed_at: string | null;
  allocated_paise: string;
  unallocated_paise: string;
  created_by: string | null;
  created_at: string;
}

export interface CustomerReceivable {
  customer_id: string;
  business_id: string;
  customer_name: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  gstin: string | null;
  outstanding_paise: string;
  overdue_paise: string;
  total_invoiced_paise: string;
  oldest_due_date: string | null;
  open_invoice_count: number;
}

// ---------------------------------------------------------------------------
// RPC payloads
// ---------------------------------------------------------------------------

export interface CreateInvoiceLinePayload {
  description: string;
  hsn_sac: string | null;
  quantity: string;
  unit: string | null;
  unit_price_paise: string;
  /** Legacy percentage discount. Ignored when `discount_type` is supplied. */
  discount_percent_basis_points: number;
  /** How the discount was entered. Omit to use the legacy percentage field. */
  discount_type?: DiscountType;
  /** Basis points for 'percent', paise for 'fixed'. */
  discount_value?: string;
  tax_rate_basis_points: number;
  cess_rate_basis_points: number;
}

export interface RecordPaymentAllocationPayload {
  invoice_id: string;
  amount_paise: string;
}
