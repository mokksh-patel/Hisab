/**
 * supabase.ts — the single Supabase client for the browser.
 *
 * SECURITY: only the publishable (anon) key is used here. It is safe to ship
 * because every tenant-owned table is protected by Row Level Security. The
 * service-role key must never appear in a VITE_* variable.
 */

import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export class SupabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupabaseConfigError';
  }
}

/** True when both environment variables are present. */
export const isSupabaseConfigured = Boolean(url && publishableKey);

if (!isSupabaseConfigured) {
  // Fail loudly in development, but do not crash the whole bundle: the app
  // renders a configuration screen instead of a blank page.
  console.error(
    'Supabase is not configured. Copy .env.example to .env.local and set ' +
      'VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.',
  );
}

export const supabase = createClient(
  url ?? 'http://localhost:54321',
  publishableKey ?? 'missing-publishable-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
    },
  },
);

/** Throw a helpful error when the app is used without configuration. */
export function assertSupabaseConfigured(): void {
  if (!isSupabaseConfigured) {
    throw new SupabaseConfigError(
      'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env.local.',
    );
  }
}
