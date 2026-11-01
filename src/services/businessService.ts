/**
 * businessService.ts — businesses, memberships and onboarding.
 */

import { supabase } from '@/lib/supabase';
import { unwrap } from '@/lib/errors';
import type { Business, BusinessMember, MemberRole, Profile } from '@/types/database';

export interface BusinessWithRole extends Business {
  role: MemberRole;
}

export interface CreateBusinessInput {
  legalName: string;
  displayName: string;
  businessType?: string | null;
  gstin?: string | null;
  city?: string | null;
  stateCode?: string | null;
  phone?: string | null;
  email?: string | null;
  isGstRegistered?: boolean;
  invoicePrefix?: string;
  defaultCreditPeriodDays?: number;
}

/** All businesses the signed-in user belongs to, with their role. */
export async function listMyBusinesses(): Promise<BusinessWithRole[]> {
  const memberships = unwrap(
    await supabase
      .from('business_members')
      .select('business_id, role, invitation_status')
      .eq('invitation_status', 'accepted'),
  ) as Pick<BusinessMember, 'business_id' | 'role' | 'invitation_status'>[];

  if (memberships.length === 0) return [];

  const businesses = unwrap(
    await supabase
      .from('businesses')
      .select('*')
      .in('id', memberships.map((m) => m.business_id))
      .order('created_at', { ascending: true }),
  ) as Business[];

  const roleByBusiness = new Map(memberships.map((m) => [m.business_id, m.role]));
  return businesses.map((business) => ({
    ...business,
    role: roleByBusiness.get(business.id) ?? 'read_only',
  }));
}

export async function getBusiness(businessId: string): Promise<Business> {
  return unwrap(
    await supabase.from('businesses').select('*').eq('id', businessId).single(),
  ) as Business;
}

/** Creates a business and makes the caller its owner, atomically. */
export async function createBusiness(input: CreateBusinessInput): Promise<string> {
  const data = unwrap(
    await supabase.rpc('create_business_with_owner', {
      p_legal_name: input.legalName,
      p_display_name: input.displayName,
      p_business_type: input.businessType ?? null,
      p_gstin: input.gstin ?? null,
      p_city: input.city ?? null,
      p_state_code: input.stateCode ?? null,
      p_phone: input.phone ?? null,
      p_email: input.email ?? null,
      p_is_gst_registered: input.isGstRegistered ?? false,
      p_invoice_prefix: input.invoicePrefix ?? 'INV',
      p_default_credit_period_days: input.defaultCreditPeriodDays ?? 30,
    }),
  );
  return data as string;
}

export async function updateBusiness(
  businessId: string,
  patch: Partial<Omit<Business, 'id' | 'created_at' | 'updated_at'>>,
): Promise<Business> {
  return unwrap(
    await supabase.from('businesses').update(patch).eq('id', businessId).select('*').single(),
  ) as Business;
}

export async function listMembers(businessId: string): Promise<BusinessMember[]> {
  return unwrap(
    await supabase
      .from('business_members')
      .select('*')
      .eq('business_id', businessId)
      .order('created_at', { ascending: true }),
  ) as BusinessMember[];
}

export async function getProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (error) throw error;
  return data as Profile | null;
}

export async function updateProfile(
  userId: string,
  patch: { full_name?: string; phone?: string | null },
): Promise<Profile> {
  return unwrap(
    await supabase.from('profiles').update(patch).eq('id', userId).select('*').single(),
  ) as Profile;
}
