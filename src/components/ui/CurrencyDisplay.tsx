import { formatPaise, type Paise } from '@/lib/money';
import { cn } from '@/lib/cn';

export interface CurrencyDisplayProps {
  /** Amount in paise. Pass a bigint — never a float. */
  value: Paise;
  /** Show the two decimal places. Defaults to true. */
  showDecimals?: boolean;
  className?: string;
  /** Render in a muted style (e.g. a zero balance). */
  muted?: boolean;
}

/**
 * The only component that renders money. Centralising it guarantees every
 * figure on screen uses the same Indian grouping and the same paise source.
 */
export function CurrencyDisplay({ value, showDecimals = true, className, muted }: CurrencyDisplayProps) {
  return (
    <span
      className={cn('tabular', muted && 'text-muted', className)}
      title={formatPaise(value)}
    >
      {formatPaise(value, { showDecimals })}
    </span>
  );
}
