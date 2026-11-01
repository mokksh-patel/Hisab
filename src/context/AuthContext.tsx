/**
 * AuthContext.tsx — the single source of truth for the signed-in session.
 *
 * The session is restored from Supabase on mount and kept in sync through
 * `onAuthStateChange`. Components never call `supabase.auth` directly; they
 * read `useAuth()`.
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
import type { Session, User } from '@supabase/supabase-js';
import { getSession, onAuthStateChange, signOut as signOutService } from '@/services/authService';
import { isSupabaseConfigured } from '@/lib/supabase';

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  /** True until the initial session lookup finishes. */
  loading: boolean;
  /** True when the Supabase environment variables are missing. */
  misconfigured: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    getSession()
      .then((restored) => {
        if (!cancelled) setSession(restored);
      })
      .catch(() => {
        // A failed session restore is not fatal: the user simply lands on the
        // login screen. We never surface a raw auth error here.
        if (!cancelled) setSession(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    const unsubscribe = onAuthStateChange((next) => {
      if (!cancelled) setSession(next);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const signOut = useCallback(async () => {
    await signOutService();
    setSession(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: session?.user ?? null,
      session,
      loading,
      misconfigured: !isSupabaseConfigured,
      signOut,
    }),
    [session, loading, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
