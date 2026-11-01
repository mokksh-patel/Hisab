import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { FullPageLoader } from '@/components/layout/FullPageLoader';
import { AuthLayout } from './AuthLayout';

/**
 * Landing page for the email-confirmation link.
 *
 * Supabase (PKCE flow) puts a `code` in the query string. We exchange it for a
 * session, then send the user onward. If the exchange fails we show a clear
 * message rather than a blank screen.
 */
export function AuthCallbackPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function exchange() {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      const errorDescription = params.get('error_description');

      if (errorDescription) {
        if (!cancelled) setError(errorDescription);
        return;
      }

      if (!code) {
        // No code: the session may already have been established by
        // detectSessionInUrl. Send the user to the app and let the guards decide.
        if (!cancelled) navigate('/', { replace: true });
        return;
      }

      const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
      if (cancelled) return;

      if (exchangeError) {
        setError('This confirmation link is invalid or has expired. Please sign in again.');
        return;
      }
      navigate('/', { replace: true });
    }

    void exchange();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  if (error) {
    return (
      <AuthLayout title="Link could not be verified" subtitle="The link may have expired.">
        <div role="alert" className="rounded-lg border border-coral-100 bg-coral-50 px-3 py-2 text-sm text-coral-700">
          {error}
        </div>
        <button
          type="button"
          onClick={() => navigate('/login', { replace: true })}
          className="mt-4 h-11 w-full rounded-lg bg-navy-700 text-sm font-medium text-white hover:bg-navy-800"
        >
          Go to sign in
        </button>
      </AuthLayout>
    );
  }

  return <FullPageLoader label="Verifying your link" />;
}
