/**
 * BusinessContext.tsx — the currently selected business and the caller's role.
 *
 * A user may belong to several businesses. The selected business id is
 * persisted in localStorage so a reload keeps the same context. The role is
 * used only to hide controls the user cannot use; the database is the real
 * authority (RLS + SECURITY DEFINER checks).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { listMyBusinesses, type BusinessWithRole } from '@/services/businessService';
import { useAuth } from './AuthContext';
import type { MemberRole } from '@/types/database';

const STORAGE_KEY = 'bizpilot.selectedBusinessId';

/** Roles allowed to write financial documents (mirrors can_write_financials). */
const WRITE_ROLES: MemberRole[] = ['owner', 'admin', 'accountant'];
/** Roles allowed to manage the business (mirrors can_manage_business). */
const MANAGE_ROLES: MemberRole[] = ['owner', 'admin'];

interface BusinessContextValue {
  businesses: BusinessWithRole[];
  currentBusiness: BusinessWithRole | null;
  currentBusinessId: string | null;
  role: MemberRole | null;
  loading: boolean;
  error: Error | null;
  canWriteFinancials: boolean;
  canManageBusiness: boolean;
  selectBusiness: (businessId: string) => void;
  refetch: () => void;
}

const BusinessContext = createContext<BusinessContextValue | null>(null);

export function BusinessProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  });

  const query = useQuery({
    queryKey: ['my-businesses', user?.id],
    queryFn: listMyBusinesses,
    enabled: Boolean(user),
    staleTime: 60_000,
  });

  const businesses = query.data ?? [];

  // Keep the selection valid. When the stored id no longer exists (removed
  // membership, different account, first visit) fall back to the MOST RECENTLY
  // CREATED business. `listMyBusinesses` orders by created_at ascending, so the
  // newest is last. Choosing the newest is deterministic and matches what a user
  // expects right after onboarding.
  useEffect(() => {
    if (businesses.length === 0) return;
    const stillValid = selectedId && businesses.some((b) => b.id === selectedId);
    if (!stillValid) {
      const newest = businesses[businesses.length - 1]!;
      setSelectedId(newest.id);
      try {
        localStorage.setItem(STORAGE_KEY, newest.id);
      } catch {
        /* storage unavailable — selection stays in memory only */
      }
    }
  }, [businesses, selectedId]);

  const selectBusiness = useCallback((businessId: string) => {
    setSelectedId(businessId);
    try {
      localStorage.setItem(STORAGE_KEY, businessId);
    } catch {
      /* ignore */
    }
  }, []);

  const currentBusiness = useMemo(
    () => businesses.find((b) => b.id === selectedId) ?? null,
    [businesses, selectedId],
  );

  const role = currentBusiness?.role ?? null;

  const value = useMemo<BusinessContextValue>(
    () => ({
      businesses,
      currentBusiness,
      currentBusinessId: currentBusiness?.id ?? null,
      role,
      loading: authLoading || (Boolean(user) && query.isLoading),
      error: (query.error as Error | null) ?? null,
      canWriteFinancials: role ? WRITE_ROLES.includes(role) : false,
      canManageBusiness: role ? MANAGE_ROLES.includes(role) : false,
      selectBusiness,
      refetch: () => {
        void query.refetch();
      },
    }),
    [businesses, currentBusiness, role, authLoading, user, query, selectBusiness],
  );

  return <BusinessContext.Provider value={value}>{children}</BusinessContext.Provider>;
}

export function useBusiness(): BusinessContextValue {
  const context = useContext(BusinessContext);
  if (!context) throw new Error('useBusiness must be used inside a BusinessProvider');
  return context;
}
