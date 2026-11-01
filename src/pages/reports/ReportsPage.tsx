import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useBusiness } from '@/context/BusinessContext';
import { getAgingReport, getCollectionTrend } from '@/services/reportService';
import { listCustomerReceivables } from '@/services/customerService';
import { todayInTimeZone, formatDate } from '@/lib/dateUtils';
import { parsePaise } from '@/lib/money';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { CurrencyDisplay } from '@/components/ui/CurrencyDisplay';
import { Input } from '@/components/ui/Input';
import { AgingChart } from '@/components/dashboard/AgingChart';
import { EmptyState, ErrorState, Skeleton, TableSkeleton } from '@/components/ui/States';

export default function ReportsPage() {
  const { currentBusinessId, currentBusiness } = useBusiness();
  const today = todayInTimeZone(currentBusiness?.timezone ?? 'Asia/Kolkata');
  const [asOf, setAsOf] = useState(today);

  const agingQuery = useQuery({
    queryKey: ['aging-report', currentBusinessId, asOf],
    queryFn: () => getAgingReport(currentBusinessId!, asOf),
    enabled: Boolean(currentBusinessId),
  });

  const receivablesQuery = useQuery({
    queryKey: ['customer-receivables', currentBusinessId],
    queryFn: () => listCustomerReceivables(currentBusinessId!),
    enabled: Boolean(currentBusinessId),
  });

  const trendQuery = useQuery({
    queryKey: ['collection-trend', currentBusinessId, today],
    queryFn: () => getCollectionTrend(currentBusinessId!, 6, today),
    enabled: Boolean(currentBusinessId),
  });

  const aging = agingQuery.data;
  const withDues = (receivablesQuery.data ?? []).filter(
    (row) => parsePaise(row.outstanding_paise) > 0n,
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reports"
        description="Aging and collections, calculated from live allocations."
        actions={
          <div className="w-44">
            <Input
              label="As of"
              type="date"
              value={asOf}
              max={today}
              onChange={(event) => setAsOf(event.target.value || today)}
            />
          </div>
        }
      />

      <Card>
        <CardHeader
          title="Aging summary"
          description={`Outstanding balance by days past due as of ${formatDate(asOf)}`}
        />
        <CardBody>
          {agingQuery.isError ? (
            <ErrorState onRetry={() => void agingQuery.refetch()} />
          ) : agingQuery.isLoading || !aging ? (
            <Skeleton className="h-48 w-full" />
          ) : (
            <>
              <AgingChart report={aging} height={240} />
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[520px] text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs font-medium text-muted">
                      <th scope="col" className="py-2">Bucket</th>
                      <th scope="col" className="py-2 text-right">Invoices</th>
                      <th scope="col" className="py-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {aging.buckets.map((bucket) => (
                      <tr key={bucket.bucket}>
                        <td className="py-2.5 text-ink">{bucket.label}</td>
                        <td className="py-2.5 text-right tabular text-muted">{bucket.invoiceCount}</td>
                        <td className="py-2.5 text-right">
                          <CurrencyDisplay value={bucket.amountPaise} muted={bucket.amountPaise === 0n} />
                        </td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-line font-semibold">
                      <td className="py-2.5">Total outstanding</td>
                      <td className="py-2.5 text-right tabular">{aging.totalInvoiceCount}</td>
                      <td className="py-2.5 text-right">
                        <CurrencyDisplay value={aging.totalOutstandingPaise} />
                      </td>
                    </tr>
                    <tr className="font-medium text-coral-700">
                      <td className="py-2.5">Of which overdue</td>
                      <td className="py-2.5" />
                      <td className="py-2.5 text-right">
                        <CurrencyDisplay value={aging.totalOverduePaise} />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Customer-wise dues" description="Customers with an outstanding balance" />
        {receivablesQuery.isError ? (
          <ErrorState onRetry={() => void receivablesQuery.refetch()} />
        ) : receivablesQuery.isLoading ? (
          <TableSkeleton rows={5} columns={4} />
        ) : withDues.length === 0 ? (
          <EmptyState title="No outstanding balances" description="Every issued invoice is settled." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs font-medium text-muted">
                  <th scope="col" className="px-4 py-2.5 sm:px-5">Customer</th>
                  <th scope="col" className="px-4 py-2.5 text-right">Open invoices</th>
                  <th scope="col" className="px-4 py-2.5 text-right">Outstanding</th>
                  <th scope="col" className="px-4 py-2.5 text-right sm:px-5">Overdue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {withDues.map((row) => (
                  <tr key={row.customer_id}>
                    <td className="px-4 py-3 text-ink sm:px-5">{row.customer_name}</td>
                    <td className="px-4 py-3 text-right tabular text-muted">{row.open_invoice_count}</td>
                    <td className="px-4 py-3 text-right">
                      <CurrencyDisplay value={parsePaise(row.outstanding_paise)} />
                    </td>
                    <td className="px-4 py-3 text-right sm:px-5">
                      <CurrencyDisplay
                        value={parsePaise(row.overdue_paise)}
                        muted={parsePaise(row.overdue_paise) === 0n}
                        className={parsePaise(row.overdue_paise) > 0n ? 'font-medium text-coral-700' : undefined}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Collection trend" description="Payments received over the last 6 months" />
        <CardBody>
          {trendQuery.isError ? (
            <ErrorState onRetry={() => void trendQuery.refetch()} />
          ) : trendQuery.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <ul className="divide-y divide-line">
              {(trendQuery.data ?? []).map((point) => (
                <li key={point.month} className="flex items-center justify-between py-2.5 text-sm">
                  <span className="text-muted">{point.month}</span>
                  <CurrencyDisplay value={point.amountPaise} muted={point.amountPaise === 0n} />
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
