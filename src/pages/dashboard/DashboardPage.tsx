import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, ArrowRight, Clock, Plus, TrendingUp, Wallet } from 'lucide-react';
import { useBusiness } from '@/context/BusinessContext';
import { getAgingReport, getDashboardSummary, getFollowUpList } from '@/services/reportService';
import { listInvoices } from '@/services/invoiceService';
import { todayInTimeZone } from '@/lib/dateUtils';
import { parsePaise } from '@/lib/money';
import { deriveInvoiceStatus } from '@/lib/receivablesAging';
import { PageHeader } from '@/components/layout/PageHeader';
import { FinancialStatCard } from '@/components/dashboard/FinancialStatCard';
import { AgingChart } from '@/components/dashboard/AgingChart';
import { CurrencyDisplay } from '@/components/ui/CurrencyDisplay';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState, ErrorState, Skeleton, TableSkeleton } from '@/components/ui/States';
import { formatDate, describeDueDate } from '@/lib/dateUtils';

export default function DashboardPage() {
  const { currentBusinessId, currentBusiness } = useBusiness();
  const today = todayInTimeZone(currentBusiness?.timezone ?? 'Asia/Kolkata');

  const summaryQuery = useQuery({
    queryKey: ['dashboard-summary', currentBusinessId, today],
    queryFn: () => getDashboardSummary(currentBusinessId!, today),
    enabled: Boolean(currentBusinessId),
  });

  const agingQuery = useQuery({
    queryKey: ['aging-report', currentBusinessId, today],
    queryFn: () => getAgingReport(currentBusinessId!, today),
    enabled: Boolean(currentBusinessId),
  });

  const followUpQuery = useQuery({
    queryKey: ['follow-up', currentBusinessId, today],
    queryFn: () => getFollowUpList(currentBusinessId!, today, 5),
    enabled: Boolean(currentBusinessId),
  });

  const recentQuery = useQuery({
    queryKey: ['recent-invoices', currentBusinessId],
    queryFn: () => listInvoices(currentBusinessId!, { limit: 8 }),
    enabled: Boolean(currentBusinessId),
  });

  const summary = summaryQuery.data;
  const recent = recentQuery.data?.rows ?? [];

  const greeting = useMemo(() => {
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: currentBusiness?.timezone ?? 'Asia/Kolkata',
        hour: '2-digit',
        hour12: false,
      }).format(new Date()),
    );
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  }, [currentBusiness?.timezone]);

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${greeting}`}
        description={`${currentBusiness?.display_name ?? 'Your business'} · ${formatDate(today)}`}
        actions={
          <>
            <Link to="/invoices/new">
              <Button size="sm">
                <Plus className="size-4" aria-hidden="true" />
                Create invoice
              </Button>
            </Link>
            <Link to="/payments">
              <Button size="sm" variant="secondary">
                <Wallet className="size-4" aria-hidden="true" />
                Record payment
              </Button>
            </Link>
          </>
        }
      />

      {/* KPI cards */}
      {summaryQuery.isError ? (
        <Card>
          <ErrorState
            message="Could not load your dashboard figures."
            onRetry={() => void summaryQuery.refetch()}
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {summaryQuery.isLoading || !summary ? (
            Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="card p-5">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="mt-3 h-7 w-32" />
                <Skeleton className="mt-2 h-3 w-20" />
              </div>
            ))
          ) : (
            <>
              <FinancialStatCard
                label="Total outstanding"
                value={<CurrencyDisplay value={summary.totalOutstandingPaise} />}
                hint={`${summary.openInvoiceCount} open invoice${summary.openInvoiceCount === 1 ? '' : 's'}`}
                icon={<TrendingUp className="size-4" />}
              />
              <FinancialStatCard
                label="Overdue"
                value={<CurrencyDisplay value={summary.overduePaise} />}
                hint={
                  summary.overdueCustomerCount > 0
                    ? `${summary.overdueCustomerCount} customer${summary.overdueCustomerCount === 1 ? '' : 's'} overdue`
                    : 'Nothing overdue'
                }
                tone={summary.overduePaise > 0n ? 'danger' : 'default'}
                icon={<AlertCircle className="size-4" />}
              />
              <FinancialStatCard
                label="Collected this month"
                value={<CurrencyDisplay value={summary.collectedThisMonthPaise} />}
                hint="Payments received, excluding reversed"
                tone="success"
                icon={<Wallet className="size-4" />}
              />
              <FinancialStatCard
                label="Due within 7 days"
                value={<CurrencyDisplay value={summary.dueWithin7DaysPaise} />}
                hint="Not yet overdue"
                tone={summary.dueWithin7DaysPaise > 0n ? 'warning' : 'default'}
                icon={<Clock className="size-4" />}
              />
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        {/* Aging chart */}
        <Card className="xl:col-span-2">
          <CardHeader
            title="Receivables aging"
            description="Outstanding balance by days past due"
            action={
              <Link to="/reports" className="text-sm font-medium text-navy-700 hover:underline">
                View report
              </Link>
            }
          />
          <CardBody>
            {agingQuery.isError ? (
              <ErrorState onRetry={() => void agingQuery.refetch()} />
            ) : agingQuery.isLoading || !agingQuery.data ? (
              <div className="space-y-3 py-6">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-40 w-full" />
              </div>
            ) : (
              <AgingChart report={agingQuery.data} />
            )}
          </CardBody>
        </Card>

        {/* Follow-up list */}
        <Card>
          <CardHeader title="Follow up today" description="Most overdue invoices" />
          {followUpQuery.isError ? (
            <ErrorState onRetry={() => void followUpQuery.refetch()} />
          ) : followUpQuery.isLoading ? (
            <TableSkeleton rows={4} columns={2} />
          ) : (followUpQuery.data ?? []).length === 0 ? (
            <EmptyState
              title="Nothing overdue"
              description="Every issued invoice is either paid or not yet due."
            />
          ) : (
            <ul className="divide-y divide-line">
              {followUpQuery.data!.map((row) => (
                <li key={row.invoiceId}>
                  <Link
                    to={`/invoices/${row.invoiceId}`}
                    className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50 sm:px-5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">{row.customerName}</p>
                      <p className="text-xs text-muted">
                        {row.invoiceNumber} · {row.daysOverdue} day
                        {row.daysOverdue === 1 ? '' : 's'} overdue
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <CurrencyDisplay value={row.outstandingPaise} className="text-sm font-medium" />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* Recent invoices */}
      <Card>
        <CardHeader
          title="Recent invoices"
          description="Latest invoices by due date"
          action={
            <Link
              to="/invoices"
              className="inline-flex items-center gap-1 text-sm font-medium text-navy-700 hover:underline"
            >
              All invoices
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          }
        />
        {recentQuery.isError ? (
          <ErrorState onRetry={() => void recentQuery.refetch()} />
        ) : recentQuery.isLoading ? (
          <TableSkeleton rows={5} columns={5} />
        ) : recent.length === 0 ? (
          <EmptyState
            title="No invoices yet"
            description="Create your first invoice to start tracking receivables."
            action={
              <Link to="/invoices/new">
                <Button size="sm">
                  <Plus className="size-4" aria-hidden="true" />
                  Create invoice
                </Button>
              </Link>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs font-medium text-muted">
                  <th scope="col" className="px-4 py-2.5 sm:px-5">Invoice</th>
                  <th scope="col" className="px-4 py-2.5">Customer</th>
                  <th scope="col" className="px-4 py-2.5">Due</th>
                  <th scope="col" className="px-4 py-2.5 text-right">Total</th>
                  <th scope="col" className="px-4 py-2.5 text-right">Outstanding</th>
                  <th scope="col" className="px-4 py-2.5 sm:px-5">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {recent.map((invoice) => {
                  const total = parsePaise(invoice.total_amount_paise);
                  const outstanding = parsePaise(invoice.outstanding_paise);
                  const status = deriveInvoiceStatus({
                    documentState: invoice.document_state,
                    totalAmountPaise: total,
                    outstandingPaise: outstanding,
                    dueDate: invoice.due_date,
                    asOf: today,
                  });
                  return (
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
                      <td className="px-4 py-3 text-muted">
                        <span className="block">{formatDate(invoice.due_date)}</span>
                        <span className="text-xs">{describeDueDate(invoice.due_date, today)}</span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <CurrencyDisplay value={total} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <CurrencyDisplay value={outstanding} muted={outstanding === 0n} />
                      </td>
                      <td className="px-4 py-3 sm:px-5">
                        <StatusBadge status={status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
