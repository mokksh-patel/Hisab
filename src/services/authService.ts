/**
 * authService.ts — Supabase Auth wrapper.
 *
 * All authentication goes through this module so the rest of the app never
 * touches the Supabase auth API directly.
 */

import { supabase, assertSupabaseConfigured } from '@/lib/supabase';
import { AppError, toAppError } from '@/lib/errors';
import type { Session, User } from '@supabase/supabase-js';

export interface SignUpInput {
  email: string;
  password: string;
  fullName: string;
  phone?: string;
}

export interface SignInInput {
  email: string;
  password: string;
}

/** Absolute URL used for email confirmation and password reset redirects. */
function redirectTo(path: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}${path}`;
}

export async function signUp(input: SignUpInput): Promise<{ user: User | null; needsEmailConfirmation: boolean }> {
  assertSupabaseConfigured();
  const { data, error } = await supabase.auth.signUp({
    email: input.email.trim().toLowerCase(),
    password: input.password,
    options: {
      emailRedirectTo: redirectTo('/auth/callback'),
      data: {
        full_name: input.fullName.trim(),
        phone: input.phone?.trim() ?? null,
      },
    },
  });
  if (error) throw toAppError(error);

  // When email confirmation is enabled Supabase returns a user but no session.
  return { user: data.user, needsEmailConfirmation: data.session === null };
}

export async function signIn(input: SignInInput): Promise<Session> {
  assertSupabaseConfigured();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: input.email.trim().toLowerCase(),
    password: input.password,
  });
  if (error) {
    if (error.message.toLowerCase().includes('invalid login credentials')) {
      throw new AppError('Incorrect email or password.', 'invalid_credentials');
    }
    if (error.message.toLowerCase().includes('email not confirmed')) {
      throw new AppError('Please confirm your email address before signing in.', 'email_not_confirmed');
    }
    throw toAppError(error);
  }
  if (!data.session) throw new AppError('Sign in failed. Please try again.', 'no_session');
  return data.session;
}

export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) throw toAppError(error);
}

export async function requestPasswordReset(email: string): Promise<void> {
  assertSupabaseConfigured();
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
    redirectTo: redirectTo('/auth/reset-password'),
  });
  if (error) throw toAppError(error);
}

export async function updatePassword(newPassword: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw toAppError(error);
}

export async function resendVerificationEmail(email: string): Promise<void> {
  const { error } = await supabase.auth.resend({
    type: 'signup',
    email: email.trim().toLowerCase(),
    options: { emailRedirectTo: redirectTo('/auth/callback') },
  });
  if (error) throw toAppError(error);
}

export async function getSession(): Promise<Session | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw toAppError(error);
  return data.session;
}

export function onAuthStateChange(callback: (session: Session | null) => void): () => void {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session);
  });
  return () => data.subscription.unsubscribe();
}
