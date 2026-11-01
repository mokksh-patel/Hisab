/**
 * customerService.ts — customer CRUD and receivables summaries.
 */

import { supabase } from '@/lib/supabase';
import { unwrap } from '@/lib/errors';
import { normalisePhone } from '@/lib/phone';
import type { Customer, CustomerReceivable } from '@/types/database';

export interface CustomerInput {
  customer_name: string;
  phone?: string | null;
  email?: string | null;
  gstin?: string | null;
  billing_address?: string | null;
  shipping_address?: string | null;
  city?: string | null;
  state_code?: string | null;
  credit_period_days?: number;
  credit_limit_paise?: string;
  notes?: string | null;
}

/** Normalise user input before it reaches the database. */
function prepare(input: CustomerInput): CustomerInput {
  return {
    ...input,
    customer_name: input.customer_name.trim(),
    phone: input.phone ? normalisePhone(input.phone) : null,
    email: input.email?.trim().toLowerCase() || null,
    gstin: input.gstin?.trim().toUpperCase() || null,
    city: input.city?.trim() || null,
    notes: input.notes?.trim() || null,
  };
}

export async function listCustomers(businessId: string): Promise<Customer[]> {
  return unwrap(
    await supabase
      .from('customers')
      .select('*')
      .eq('business_id', businessId)
      .eq('is_active', true)
      .order('customer_name', { ascending: true }),
  ) as Customer[];
}

export async function getCustomer(customerId: string): Promise<Customer> {
  return unwrap(
    await supabase.from('customers').select('*').eq('id', customerId).single(),
  ) as Customer;
}

export async function createCustomer(businessId: string, input: CustomerInput): Promise<Customer> {
  return unwrap(
    await supabase
      .from('customers')
      .insert({ ...prepare(input), business_id: businessId })
      .select('*')
      .single(),
  ) as Customer;
}

export async function updateCustomer(customerId: string, input: CustomerInput): Promise<Customer> {
  return unwrap(
    await supabase.from('customers').update(prepare(input)).eq('id', customerId).select('*').single(),
  ) as Customer;
}

/** Customers with their outstanding and overdue balances (from the SQL view). */
export async function listCustomerReceivables(businessId: string): Promise<CustomerReceivable[]> {
  return unwrap(
    await supabase
      .from('customer_receivables')
      .select('*')
      .eq('business_id', businessId)
      .order('outstanding_paise', { ascending: false }),
  ) as CustomerReceivable[];
}

export async function getCustomerReceivable(customerId: string): Promise<CustomerReceivable | null> {
  const { data, error } = await supabase
    .from('customer_receivables')
    .select('*')
    .eq('customer_id', customerId)
    .maybeSingle();
  if (error) throw error;
  return data as CustomerReceivable | null;
}
