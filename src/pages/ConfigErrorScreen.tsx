import { AlertTriangle } from 'lucide-react';

/**
 * Shown when VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY are missing.
 * A blank white page is never an acceptable failure mode.
 */
export function ConfigErrorScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-page px-4">
      <div className="w-full max-w-lg rounded-xl border border-line bg-surface p-6">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning-600" aria-hidden="true" />
          <div>
            <h1 className="text-lg font-semibold text-ink">Configuration required</h1>
            <p className="mt-2 text-sm text-muted">
              BizPilot could not find its Supabase configuration. Create a{' '}
              <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">.env.local</code> file in
              the project root with the following values, then restart the dev server.
            </p>
            <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
{`VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<publishable-anon-key>`}
            </pre>
            <p className="mt-3 text-xs text-muted">
              Only the publishable (anon) key belongs here. Never put a service-role key in a
              VITE_ variable — it would be inlined into the public JavaScript bundle.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
