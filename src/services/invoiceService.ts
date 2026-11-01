/**
 * invoiceService.ts — invoice creation, issuing, listing and detail.
 *
 * Totals are always computed by the database function; the client-side
 * calculation in lib/invoiceCalculations.ts is used only for the live preview.
 */

import { supabase } from '@/lib/supabase';
import { unwrap } from '@/lib/errors';
import type {
  CreateInvoiceLinePayload,
  GstMode,
  Invoice,
  InvoiceBalance,
  InvoiceItem,
} from '@/types/database';

export interface CreateInvoiceInput {
  businessId: string;
  customerId: string;
  invoiceDate: string;
  dueDate: string;
  gstMode: GstMode;
  placeOfSupplyStateCode: string | null;
  lines: CreateInvoiceLinePayload[];
  notes?: string | null;
  invoiceNumber?: string | null;
}

export interface InvoiceListFilters {
  search?: string;
  documentState?: 'draft' | 'issued' | 'void';
  customerId?: string;
  fromDate?: string;
  toDate?: string;
  onlyOutstanding?: boolean;
  limit?: number;
  offset?: number;
}

export interface InvoiceWithBalance extends InvoiceBalance {
  customer_name: string;
}

export async function createInvoice(input: CreateInvoiceInput): Promise<string> {
  const data = unwrap(
    await supabase.rpc('create_invoice', {
      p_business_id: input.businessId,
      p_customer_id: input.customerId,
      p_invoice_date: input.invoiceDate,
      p_due_date: input.dueDate,
      p_gst_mode: input.gstMode,
      p_place_of_supply_state_code: input.placeOfSupplyStateCode,
      p_lines: input.lines,
      p_notes: input.notes ?? null,
      p_invoice_number: input.invoiceNumber ?? null,
    }),
  );
  return data as string;
}

export async function issueInvoice(invoiceId: string): Promise<void> {
  unwrap(await supabase.rpc('issue_invoice', { p_invoice_id: invoiceId }));
}

export async function voidInvoice(invoiceId: string, reason: string): Promise<void> {
  unwrap(await supabase.rpc('void_invoice', { p_invoice_id: invoiceId, p_reason: reason }));
}

export async function getInvoice(invoiceId: string): Promise<Invoice> {
  return unwrap(
    await supabase.from('invoices').select('*').eq('id', invoiceId).single(),
  ) as Invoice;
}

export async function getInvoiceItems(invoiceId: string): Promise<InvoiceItem[]> {
  return unwrap(
    await supabase
      .from('invoice_items')
      .select('*')
      .eq('invoice_id', invoiceId)
      .order('line_number', { ascending: true }),
  ) as InvoiceItem[];
}

export async function getInvoiceBalance(invoiceId: string): Promise<InvoiceBalance> {
  return unwrap(
    await supabase.from('invoice_balances').select('*').eq('invoice_id', invoiceId).single(),
  ) as InvoiceBalance;
}

/**
 * Paginated invoice list with balances and customer names.
 * Filtering and pagination happen in the database, never in the browser.
 */
export async function listInvoices(
  businessId: string,
  filters: InvoiceListFilters = {},
): Promise<{ rows: InvoiceWithBalance[]; total: number }> {
  const limit = filters.limit ?? 25;
  const offset = filters.offset ?? 0;

  // PostgREST cannot resolve a dotted embedded path (customers.customer_name)
  // inside an `or()` filter on a view — it fails with PGRST100. So a search term
  // is resolved in two steps: first find matching customer ids, then filter
  // invoices by number OR those customer ids.
  let searchCustomerIds: string[] | null = null;
  const term = filters.search?.trim();
  if (term) {
    const { data: matches, error: customerError } = await supabase
      .from('customers')
      .select('id')
      .eq('business_id', businessId)
      .ilike('customer_name', `%${term}%`)
      .limit(200);

    if (customerError) throw customerError;
    searchCustomerIds = (matches ?? []).map((row) => (row as { id: string }).id);
  }

  let query = supabase
    .from('invoice_balances')
    .select('*, customers!inner(customer_name)', { count: 'exact' })
    .eq('business_id', businessId)
    .order('due_date', { ascending: true })
    .range(offset, offset + limit - 1);

  if (filters.documentState) query = query.eq('document_state', filters.documentState);
  if (filters.customerId) query = query.eq('customer_id', filters.customerId);
  if (filters.fromDate) query = query.gte('invoice_date', filters.fromDate);
  if (filters.toDate) query = query.lte('invoice_date', filters.toDate);
  if (filters.onlyOutstanding) query = query.gt('outstanding_paise', 0);

  if (term) {
    // Match the invoice number, or any invoice belonging to a matching customer.
    const escaped = term.replace(/[(),]/g, ' ');
    const clauses = [`invoice_number.ilike.%${escaped}%`];
    if (searchCustomerIds && searchCustomerIds.length > 0) {
      clauses.push(`customer_id.in.(${searchCustomerIds.join(',')})`);
    }
    query = query.or(clauses.join(','));
  }

  const { data, error, count } = await query;
  if (error) throw error;

  const rows = (data ?? []).map((row) => {
    const { customers, ...rest } = row as InvoiceBalance & { customers: { customer_name: string } };
    return { ...rest, customer_name: customers?.customer_name ?? 'Unknown customer' };
  });

  return { rows, total: count ?? rows.length };
}

/** Open (issued, unpaid) invoices for a customer — used by the payment sheet. */
export async function listOpenInvoicesForCustomer(customerId: string): Promise<InvoiceBalance[]> {
  return unwrap(
    await supabase
      .from('invoice_balances')
      .select('*')
      .eq('customer_id', customerId)
      .eq('document_state', 'issued')
      .gt('outstanding_paise', 0)
      .order('due_date', { ascending: true }),
  ) as InvoiceBalance[];
}
