import { Loader2 } from 'lucide-react';

/** Full-viewport loading state used while a session or business resolves. */
export function FullPageLoader({ label = 'Loading' }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-screen flex-col items-center justify-center gap-3 bg-page"
    >
      <Loader2 className="size-6 animate-spin text-navy-600" aria-hidden="true" />
      <p className="text-sm text-muted">{label}…</p>
    </div>
  );
}
