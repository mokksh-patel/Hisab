import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useBusiness } from '@/context/BusinessContext';
import { getCustomer, getCustomerReceivable } from '@/services/customerService';
import { listInvoices } from '@/services/invoiceService';
import { listPayments } from '@/services/paymentService';
import { todayInTimeZone, formatDate, describeDueDate } from '@/lib/dateUtils';
import { parsePaise } from '@/lib/money';
import { deriveInvoiceStatus } from '@/lib/receivablesAging';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { CurrencyDisplay } from '@/components/ui/CurrencyDisplay';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ErrorState, Skeleton } from '@/components/ui/States';

export default function CustomerDetailPage() {
  const { customerId } = useParams<{ customerId: string }>();
  const { currentBusiness, currentBusinessId } = useBusiness();
  const today = todayInTimeZone(currentBusiness?.timezone ?? 'Asia/Kolkata');

  const customerQuery = useQuery({
    queryKey: ['customer', customerId],
    queryFn: () => getCustomer(customerId!),
    enabled: Boolean(customerId),
  });

  const receivableQuery = useQuery({
    queryKey: ['customer-receivable', customerId],
    queryFn: () => getCustomerReceivable(customerId!),
    enabled: Boolean(customerId),
  });

  const invoicesQuery = useQuery({
    queryKey: ['customer-invoices', currentBusinessId, customerId],
    queryFn: () => listInvoices(currentBusinessId!, { customerId, limit: 50 }),
    enabled: Boolean(currentBusinessId && customerId),
  });

  const paymentsQuery = useQuery({
    queryKey: ['customer-payments', currentBusinessId, customerId],
    queryFn: () => listPayments(currentBusinessId!, { customerId, limit: 20 }),
    enabled: Boolean(currentBusinessId && customerId),
  });

  const customer = customerQuery.data;
  const receivable = receivableQuery.data;

  if (customerQuery.isError) {
    return (
      <Card>
        <ErrorState message="Could not load this customer." onRetry={() => void customerQuery.refetch()} />
      </Card>
    );
  }

  if (customerQuery.isLoading || !customer) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Link to="/customers" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Back to customers
      </Link>

      <PageHeader
        title={customer.customer_name}
        description={[customer.phone, customer.email, customer.gstin].filter(Boolean).join(' · ') || undefined}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs text-muted">Total invoiced</p>
          <CurrencyDisplay
            value={parsePaise(receivable?.total_invoiced_paise ?? '0')}
            className="mt-1 block text-xl font-semibold"
          />
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted">Outstanding</p>
          <CurrencyDisplay
            value={parsePaise(receivable?.outstanding_paise ?? '0')}
            className="mt-1 block text-xl font-semibold"
          />
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted">Overdue</p>
          <CurrencyDisplay
            value={parsePaise(receivable?.overdue_paise ?? '0')}
            className="mt-1 block text-xl font-semibold text-coral-700"
          />
        </Card>
      </div>

      <Card>
        <CardHeader title="Invoices" />
        {invoicesQuery.isLoading ? (
          <CardBody>
            <Skeleton className="h-20 w-full" />
          </CardBody>
        ) : (invoicesQuery.data?.rows ?? []).length === 0 ? (
          <CardBody>
            <p className="py-4 text-center text-sm text-muted">No invoices for this customer yet.</p>
          </CardBody>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs font-medium text-muted">
                  <th scope="col" className="px-4 py-2.5 sm:px-5">Invoice</th>
                  <th scope="col" className="px-4 py-2.5">Due</th>
                  <th scope="col" className="px-4 py-2.5 text-right">Total</th>
                  <th scope="col" className="px-4 py-2.5 text-right">Outstanding</th>
                  <th scope="col" className="px-4 py-2.5 sm:px-5">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {invoicesQuery.data!.rows.map((invoice) => {
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

      <Card>
        <CardHeader title="Payments" description="Recent receipts from this customer" />
        {paymentsQuery.isLoading ? (
          <CardBody>
            <Skeleton className="h-16 w-full" />
          </CardBody>
        ) : (paymentsQuery.data ?? []).length === 0 ? (
          <CardBody>
            <p className="py-4 text-center text-sm text-muted">No payments recorded yet.</p>
          </CardBody>
        ) : (
          <ul className="divide-y divide-line">
            {paymentsQuery.data!.map((payment) => (
              <li key={payment.payment_id} className="flex items-center justify-between px-4 py-3 sm:px-5">
                <div>
                  <p className="text-sm text-ink">{formatDate(payment.payment_date)}</p>
                  <p className="text-xs text-muted">
                    {payment.payment_method.replace('_', ' ')}
                    {payment.reference_number ? ` · ${payment.reference_number}` : ''}
                    {payment.reversed_at ? ' · reversed' : ''}
                  </p>
                </div>
                <CurrencyDisplay
                  value={parsePaise(payment.amount_paise)}
                  className={payment.reversed_at ? 'text-muted line-through' : 'text-sm font-medium'}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
