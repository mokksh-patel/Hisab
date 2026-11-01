import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/** Shared shell for the unauthenticated screens. */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-page">
      <header className="flex h-16 items-center px-6">
        <Link to="/" className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="flex size-8 items-center justify-center rounded-lg bg-navy-700 text-sm font-bold text-white"
          >
            B
          </span>
          <span className="text-base font-semibold tracking-tight text-ink">BizPilot</span>
        </Link>
      </header>

      <main className="flex flex-1 items-start justify-center px-4 pb-16 pt-6 sm:items-center sm:pt-0">
        <div className="w-full max-w-md">
          <div className="rounded-xl border border-line bg-surface p-6 sm:p-8">
            <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
            {subtitle && <p className="mt-1.5 text-sm text-muted">{subtitle}</p>}
            <div className="mt-6">{children}</div>
          </div>
          {footer && <div className="mt-4 text-center text-sm text-muted">{footer}</div>}
        </div>
      </main>
    </div>
  );
}
