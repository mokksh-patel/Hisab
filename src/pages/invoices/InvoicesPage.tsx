import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useBusiness } from '@/context/BusinessContext';
import { listInvoices } from '@/services/invoiceService';
import { todayInTimeZone, formatDate, describeDueDate } from '@/lib/dateUtils';
import { parsePaise } from '@/lib/money';
import { deriveInvoiceStatus, type DerivedInvoiceStatus } from '@/lib/receivablesAging';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CurrencyDisplay } from '@/components/ui/CurrencyDisplay';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { SearchInput } from '@/components/ui/SearchInput';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/ui/States';
import { cn } from '@/lib/cn';

type FilterKey = 'all' | 'draft' | 'outstanding' | 'partially_paid' | 'paid' | 'overdue' | 'void';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'outstanding', label: 'Outstanding' },
  { key: 'partially_paid', label: 'Partially paid' },
  { key: 'paid', label: 'Paid' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'void', label: 'Void' },
];

const PAGE_SIZE = 25;

export default function InvoicesPage() {
  const { currentBusinessId, currentBusiness } = useBusiness();
  const today = todayInTimeZone(currentBusiness?.timezone ?? 'Asia/Kolkata');

  const [filter, setFilter] = useState<FilterKey>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);

  const query = useQuery({
    queryKey: ['invoices', currentBusinessId, search, page],
    queryFn: () =>
      listInvoices(currentBusinessId!, {
        search: search.trim() || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
    enabled: Boolean(currentBusinessId),
  });

  const rows = query.data?.rows ?? [];
  const total = query.data?.total ?? 0;

  /**
   * Status is derived, so the filter is applied after derivation. The dataset
   * per page is small (25 rows); the database still does the heavy filtering
   * for search and pagination.
   */
  const visible = useMemo(() => {
    return rows
      .map((invoice) => {
        const totalPaise = parsePaise(invoice.total_amount_paise);
        const outstanding = parsePaise(invoice.outstanding_paise);
        const status = deriveInvoiceStatus({
          documentState: invoice.document_state,
          totalAmountPaise: totalPaise,
          outstandingPaise: outstanding,
          dueDate: invoice.due_date,
          asOf: today,
        });
        return { invoice, totalPaise, outstanding, status };
      })
      .filter((row) => matchesFilter(row.status, filter));
  }, [rows, filter, today]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Invoices"
        description="Every invoice, its balance and its derived status."
        actions={
          <Link to="/invoices/new">
            <Button size="sm">
              <Plus className="size-4" aria-hidden="true" />
              Create invoice
            </Button>
          </Link>
        }
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter invoices">
          {FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setFilter(item.key)}
              aria-pressed={filter === item.key}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
                filter === item.key
                  ? 'border-navy-200 bg-navy-50 text-navy-700'
                  : 'border-line bg-white text-muted hover:bg-slate-50 hover:text-ink',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <SearchInput
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPage(0);
          }}
          placeholder="Search invoice or customer"
          className="sm:w-72"
        />
      </div>

      <Card>
        {query.isError ? (
          <ErrorState message="Could not load invoices." onRetry={() => void query.refetch()} />
        ) : query.isLoading ? (
          <TableSkeleton rows={6} columns={6} />
        ) : visible.length === 0 ? (
          <EmptyState
            title={search || filter !== 'all' ? 'No matching invoices' : 'No invoices yet'}
            description={
              search || filter !== 'all'
                ? 'Try a different search term or filter.'
                : 'Create your first invoice to start tracking receivables.'
            }
            action={
              !search && filter === 'all' ? (
                <Link to="/invoices/new">
                  <Button size="sm">
                    <Plus className="size-4" aria-hidden="true" />
                    Create invoice
                  </Button>
                </Link>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs font-medium text-muted">
                    <th scope="col" className="px-4 py-2.5 sm:px-5">Invoice</th>
                    <th scope="col" className="px-4 py-2.5">Customer</th>
                    <th scope="col" className="px-4 py-2.5">Invoice date</th>
                    <th scope="col" className="px-4 py-2.5">Due date</th>
                    <th scope="col" className="px-4 py-2.5 text-right">Total</th>
                    <th scope="col" className="px-4 py-2.5 text-right">Outstanding</th>
                    <th scope="col" className="px-4 py-2.5 sm:px-5">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {visible.map(({ invoice, totalPaise, outstanding, status }) => (
                    <tr key={invoice.invoice_id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 sm:px-5">
                        <Link
                          to={`/invoices/${invoice.invoice_id}`}
                          className="font-medium text-navy-700 hover:underline"
                        >
                          {invoice.invoice_number}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-ink">{invoice.customer_name}</td>
                      <td className="px-4 py-3 text-muted">{formatDate(invoice.invoice_date)}</td>
                      <td className="px-4 py-3 text-muted">
                        <span className="block">{formatDate(invoice.due_date)}</span>
                        <span className="text-xs">{describeDueDate(invoice.due_date, today)}</span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <CurrencyDisplay value={totalPaise} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <CurrencyDisplay value={outstanding} muted={outstanding === 0n} />
                      </td>
                      <td className="px-4 py-3 sm:px-5">
                        <StatusBadge status={status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {pageCount > 1 && (
              <div className="flex items-center justify-between border-t border-line px-4 py-3 sm:px-5">
                <p className="text-xs text-muted">
                  Page {page + 1} of {pageCount} · {total} invoice{total === 1 ? '' : 's'}
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={page === 0}
                    onClick={() => setPage((current) => Math.max(0, current - 1))}
                  >
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={page + 1 >= pageCount}
                    onClick={() => setPage((current) => current + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

function matchesFilter(status: DerivedInvoiceStatus, filter: FilterKey): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'draft':
      return status === 'draft';
    case 'void':
      return status === 'void';
    case 'paid':
      return status === 'paid';
    case 'overdue':
      return status === 'overdue';
    case 'partially_paid':
      return status === 'partially_paid';
    case 'outstanding':
      return status !== 'draft' && status !== 'void' && status !== 'paid';
    default:
      return true;
  }
}
