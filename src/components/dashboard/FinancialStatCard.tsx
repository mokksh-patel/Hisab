import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface FinancialStatCardProps {
  label: string;
  /** Pre-formatted value (use CurrencyDisplay or a plain string). */
  value: ReactNode;
  /** Secondary line: comparison, count, or context. */
  hint?: ReactNode;
  tone?: 'default' | 'danger' | 'success' | 'warning';
  icon?: ReactNode;
}

const TONE_STYLES = {
  default: 'text-ink',
  danger: 'text-coral-700',
  success: 'text-success-700',
  warning: 'text-warning-700',
} as const;

/** KPI card used on the dashboard. */
export function FinancialStatCard({ label, value, hint, tone = 'default', icon }: FinancialStatCardProps) {
  return (
    <div className="card p-4 sm:p-5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-medium text-muted">{label}</p>
        {icon && <span className="text-muted" aria-hidden="true">{icon}</span>}
      </div>
      <p className={cn('mt-2 text-2xl font-semibold tracking-tight tabular', TONE_STYLES[tone])}>
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}
