import { Badge, type BadgeTone } from '@/components/ui/Badge';
import {
  DERIVED_STATUS_LABELS,
  type DerivedInvoiceStatus,
} from '@/lib/receivablesAging';

const TONES: Record<DerivedInvoiceStatus, BadgeTone> = {
  draft: 'neutral',
  void: 'neutral',
  paid: 'success',
  partially_paid: 'info',
  overdue: 'danger',
  due_today: 'warning',
  current: 'navy',
};

/**
 * Invoice status badge. The status is always DERIVED from allocations and the
 * due date — never read from a stored status column.
 */
export function StatusBadge({ status }: { status: DerivedInvoiceStatus }) {
  return <Badge tone={TONES[status]}>{DERIVED_STATUS_LABELS[status]}</Badge>;
}
