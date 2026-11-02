import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, MessageCircle, Printer } from 'lucide-react';
import { useBusiness } from '@/context/BusinessContext';
import {
  getInvoice,
  getInvoiceBalance,
  getInvoiceItemDiscounts,
  getInvoiceItems,
  issueInvoice,
  voidInvoice,
} from '@/services/invoiceService';
import { supabase } from '@/lib/supabase';
import { toAppError, unwrap } from '@/lib/errors';
import { formatDate, describeDueDate, daysPastDue, todayInTimeZone } from '@/lib/dateUtils';
import { parsePaise, formatPaise, basisPointsToPercent } from '@/lib/money';
import { deriveInvoiceStatus } from '@/lib/receivablesAging';
import { buildReminderLink, DEFAULT_REMINDER_TEMPLATE } from '@/lib/whatsapp';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { CurrencyDisplay } from '@/components/ui/CurrencyDisplay';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ErrorState, Skeleton } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import type { PaymentAllocation } from '@/types/database';

export default function InvoiceDetailPage() {
  const { invoiceId } = useParams<{ invoiceId: string }>();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { currentBusiness, canWriteFinancials, canManageBusiness } = useBusiness();
  const today = todayInTimeZone(currentBusiness?.timezone ?? 'Asia/Kolkata');

  const [busy, setBusy] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [showVoid, setShowVoid] = useState(false);

  const invoiceQuery = useQuery({
    queryKey: ['invoice', invoiceId],
    queryFn: () => getInvoice(invoiceId!),
    enabled: Boolean(invoiceId),
  });

  const balanceQuery = useQuery({
    queryKey: ['invoice-balance', invoiceId],
    queryFn: () => getInvoiceBalance(invoiceId!),
    enabled: Boolean(invoiceId),
  });

  const itemsQuery = useQuery({
    queryKey: ['invoice-items', invoiceId],
    queryFn: () => getInvoiceItems(invoiceId!),
    enabled: Boolean(invoiceId),
  });

  /**
   * Effective discount metadata per line.
   *
   * Issued invoice lines are immutable, so their discount_type/discount_value
   * were never backfilled. The invoice_item_discounts view derives the
   * effective values from discount_percent_basis_points for those rows, so this
   * is the correct source for displaying a historical discount.
   */
  const discountsQuery = useQuery({
    queryKey: ['invoice-item-discounts', invoiceId],
    queryFn: () => getInvoiceItemDiscounts(invoiceId!),
    enabled: Boolean(invoiceId),
  });

  const discountByItemId = useMemo(() => {
    const map = new Map<string, { type: string; value: bigint }>();
    for (const row of discountsQuery.data ?? []) {
      map.set(row.invoice_item_id, {
        type: row.effective_discount_type,
        value: parsePaise(row.effective_discount_value),
      });
    }
    return map;
  }, [discountsQuery.data]);

  const allocationsQuery = useQuery({
    queryKey: ['invoice-allocations', invoiceId],
    queryFn: async () => {
      const rows = unwrap(
        await supabase
          .from('payment_allocations')
          .select('*, payments!inner(payment_date, payment_method, reversed_at, reference_number)')
          .eq('invoice_id', invoiceId!),
      ) as (PaymentAllocation & {
        payments: {
          payment_date: string;
          payment_method: string;
          reversed_at: string | null;
          reference_number: string | null;
        };
      })[];
      return rows.filter((row) => row.payments?.reversed_at === null);
    },
    enabled: Boolean(invoiceId),
  });

  const invoice = invoiceQuery.data;
  const balance = balanceQuery.data;

  const derived = useMemo(() => {
    if (!invoice || !balance) return null;
    const total = parsePaise(invoice.total_amount_paise);
    const outstanding = parsePaise(balance.outstanding_paise);
    return {
      total,
      outstanding,
      allocated: parsePaise(balance.allocated_paise),
      status: deriveInvoiceStatus({
        documentState: invoice.document_state,
        totalAmountPaise: total,
        outstandingPaise: outstanding,
        dueDate: invoice.due_date,
        asOf: today,
      }),
    };
  }, [invoice, balance, today]);

  const reminderLink = useMemo(() => {
    if (!invoice || !derived) return null;
    const snapshot = invoice.customer_snapshot as { customer_name?: string; phone?: string } | null;
    const customerName = snapshot?.customer_name ?? 'Customer';
    const phone = snapshot?.phone ?? null;
    return buildReminderLink(
      phone,
      {
        customerName,
        businessName: currentBusiness?.display_name ?? 'Our business',
        invoiceNumber: invoice.invoice_number,
        invoiceDate: invoice.invoice_date,
        dueDate: invoice.due_date,
        totalAmountPaise: derived.total,
        outstandingPaise: derived.outstanding,
        daysOverdue: Math.max(daysPastDue(invoice.due_date, today), 0),
      },
      currentBusiness?.reminder_template ?? DEFAULT_REMINDER_TEMPLATE,
    );
  }, [invoice, derived, currentBusiness, today]);

  async function handleIssue() {
    if (!invoiceId) return;
    setBusy(true);
    try {
      await issueInvoice(invoiceId);
      toast.success('Invoice issued.');
      await queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
      await queryClient.invalidateQueries({ queryKey: ['invoice-balance', invoiceId] });
      await queryClient.invalidateQueries({ queryKey: ['invoices'] });
    } catch (error) {
      toast.error(toAppError(error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleVoid() {
    if (!invoiceId || voidReason.trim() === '') {
      toast.error('Enter a reason before voiding.');
      return;
    }
    setBusy(true);
    try {
      await voidInvoice(invoiceId, voidReason.trim());
      toast.success('Invoice voided.');
      setShowVoid(false);
      setVoidReason('');
      await queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
      await queryClient.invalidateQueries({ queryKey: ['invoices'] });
    } catch (error) {
      toast.error(toAppError(error).message);
    } finally {
      setBusy(false);
    }
  }

  if (invoiceQuery.isError) {
    return (
      <Card>
        <ErrorState message="Could not load this invoice." onRetry={() => void invoiceQuery.refetch()} />
      </Card>
    );
  }

  if (invoiceQuery.isLoading || !invoice || !derived) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const snapshot = invoice.customer_snapshot as Record<string, string | null> | null;

  return (
    <div className="space-y-5">
      <Link to="/invoices" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Back to invoices
      </Link>

      <PageHeader
        title={invoice.invoice_number}
        description={`${snapshot?.customer_name ?? 'Customer'} · Issued ${formatDate(invoice.invoice_date)}`}
        actions={
          <>
            <StatusBadge status={derived.status} />
            {invoice.document_state === 'draft' && canWriteFinancials && (
              <Button size="sm" loading={busy} onClick={() => void handleIssue()}>
                Issue invoice
              </Button>
            )}
            {derived.outstanding > 0n && invoice.document_state === 'issued' && (
              <Link to={`/payments?customer=${invoice.customer_id}&invoice=${invoice.id}`}>
                <Button size="sm" variant="secondary">
                  Record payment
                </Button>
              </Link>
            )}
            {reminderLink ? (
              <a href={reminderLink} target="_blank" rel="noopener noreferrer">
                <Button size="sm" variant="secondary">
                  <MessageCircle className="size-4" aria-hidden="true" />
                  Send reminder
                </Button>
              </a>
            ) : (
              <Button size="sm" variant="secondary" disabled title="This customer has no phone number">
                <MessageCircle className="size-4" aria-hidden="true" />
                Send reminder
              </Button>
            )}
            <span data-print-hide>
              <Button size="sm" variant="ghost" onClick={() => window.print()}>
                <Printer className="size-4" aria-hidden="true" />
                Print
              </Button>
            </span>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {/* Amounts */}
          <Card>
            <CardHeader title="Amounts" />
            <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <p className="text-xs text-muted">Invoice total</p>
                <CurrencyDisplay value={derived.total} className="mt-1 block text-lg font-semibold" />
              </div>
              <div>
                <p className="text-xs text-muted">Received</p>
                <CurrencyDisplay value={derived.allocated} className="mt-1 block text-lg font-semibold text-success-700" />
              </div>
              <div>
                <p className="text-xs text-muted">Outstanding</p>
                <CurrencyDisplay
                  value={derived.outstanding}
                  className="mt-1 block text-lg font-semibold"
                />
              </div>
            </CardBody>
          </Card>

          {/* Tax breakdown */}
          <Card>
            <CardHeader
              title="Tax breakdown"
              description={
                invoice.price_includes_tax
                  ? 'Prices were entered GST-inclusive'
                  : 'Prices were entered GST-exclusive'
              }
            />
            <CardBody className="space-y-2 text-sm">
              <Detail
                label="Subtotal (before discount)"
                value={<CurrencyDisplay value={parsePaise(invoice.subtotal_paise)} />}
              />
              {parsePaise(invoice.discount_paise) > 0n && (
                <Detail
                  label="Item discounts"
                  value={<CurrencyDisplay value={parsePaise(invoice.discount_paise)} />}
                />
              )}
              {parsePaise(invoice.invoice_discount_paise) > 0n && (
                <Detail
                  label="Invoice discount"
                  value={<CurrencyDisplay value={parsePaise(invoice.invoice_discount_paise)} />}
                />
              )}
              <Detail
                label="Taxable value"
                value={<CurrencyDisplay value={parsePaise(invoice.taxable_amount_paise)} />}
              />
              {parsePaise(invoice.cgst_paise) > 0n && (
                <Detail label="CGST" value={<CurrencyDisplay value={parsePaise(invoice.cgst_paise)} />} />
              )}
              {parsePaise(invoice.sgst_paise) > 0n && (
                <Detail label="SGST" value={<CurrencyDisplay value={parsePaise(invoice.sgst_paise)} />} />
              )}
              {parsePaise(invoice.igst_paise) > 0n && (
                <Detail label="IGST" value={<CurrencyDisplay value={parsePaise(invoice.igst_paise)} />} />
              )}
              {parsePaise(invoice.cess_paise) > 0n && (
                <Detail label="Cess" value={<CurrencyDisplay value={parsePaise(invoice.cess_paise)} />} />
              )}
              <div className="flex items-center justify-between border-t border-line pt-2 text-base font-semibold">
                <span>Total</span>
                <CurrencyDisplay value={parsePaise(invoice.total_amount_paise)} />
              </div>
            </CardBody>
          </Card>

          {/* Line items */}
          <Card>
            <CardHeader title="Line items" />
            {itemsQuery.isLoading ? (
              <CardBody>
                <Skeleton className="h-20 w-full" />
              </CardBody>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs font-medium text-muted">
                      <th scope="col" className="px-4 py-2.5 sm:px-5">Description</th>
                      <th scope="col" className="px-4 py-2.5 text-right">Qty</th>
                      <th scope="col" className="px-4 py-2.5 text-right">Rate</th>
                      <th scope="col" className="px-4 py-2.5 text-right">Taxable</th>
                      <th scope="col" className="px-4 py-2.5 text-right">Tax</th>
                      <th scope="col" className="px-4 py-2.5 text-right sm:px-5">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {(itemsQuery.data ?? []).map((item) => {
                      const tax =
                        parsePaise(item.cgst_paise) +
                        parsePaise(item.sgst_paise) +
                        parsePaise(item.igst_paise) +
                        parsePaise(item.cess_paise);
                      const discount = discountByItemId.get(item.id);
                      return (
                        <tr key={item.id}>
                          <td className="px-4 py-3 sm:px-5">
                            <span className="text-ink">{item.description}</span>
                            {item.hsn_sac && (
                              <span className="ml-2 text-xs text-muted">HSN {item.hsn_sac}</span>
                            )}
                            {discount && discount.type !== 'none' && (
                              <span className="ml-2 text-xs text-success-700">
                                {discount.type === 'percent'
                                  ? `${basisPointsToPercent(discount.value)}% off`
                                  : `${formatPaise(discount.value)} off`}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right tabular text-muted">
                            {item.quantity}
                            {item.unit ? ` ${item.unit}` : ''}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <CurrencyDisplay value={parsePaise(item.unit_price_paise)} />
                          </td>
                          <td className="px-4 py-3 text-right">
                            <CurrencyDisplay value={parsePaise(item.taxable_amount_paise)} />
                          </td>
                          <td className="px-4 py-3 text-right">
                            <CurrencyDisplay value={tax} />
                          </td>
                          <td className="px-4 py-3 text-right sm:px-5">
                            <CurrencyDisplay value={parsePaise(item.line_total_paise)} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Payment history */}
          <Card>
            <CardHeader title="Payment history" description="Allocations against this invoice" />
            {allocationsQuery.isLoading ? (
              <CardBody>
                <Skeleton className="h-16 w-full" />
              </CardBody>
            ) : (allocationsQuery.data ?? []).length === 0 ? (
              <CardBody>
                <p className="py-4 text-center text-sm text-muted">No payments recorded yet.</p>
              </CardBody>
            ) : (
              <ul className="divide-y divide-line">
                {allocationsQuery.data!.map((allocation) => (
                  <li key={allocation.id} className="flex items-center justify-between px-4 py-3 sm:px-5">
                    <div>
                      <p className="text-sm text-ink">{formatDate(allocation.payments.payment_date)}</p>
                      <p className="text-xs text-muted">
                        {allocation.payments.payment_method.replace('_', ' ')}
                        {allocation.payments.reference_number
                          ? ` · ${allocation.payments.reference_number}`
                          : ''}
                      </p>
                    </div>
                    <CurrencyDisplay
                      value={parsePaise(allocation.allocated_amount_paise)}
                      className="text-sm font-medium text-success-700"
                    />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-5">
          <Card>
            <CardHeader title="Details" />
            <CardBody className="space-y-3 text-sm">
              <Detail label="Invoice date" value={formatDate(invoice.invoice_date)} />
              <Detail
                label="Due date"
                value={`${formatDate(invoice.due_date)} · ${describeDueDate(invoice.due_date, today)}`}
              />
              <Detail label="Financial year" value={invoice.financial_year} />
              <Detail label="GST treatment" value={invoice.gst_mode.replace('_', ' ')} />
              {invoice.issued_at && <Detail label="Issued" value={formatDate(invoice.issued_at.slice(0, 10))} />}
              {invoice.void_reason && <Detail label="Void reason" value={invoice.void_reason} />}
            </CardBody>
          </Card>

          {snapshot && (
            <Card>
              <CardHeader title="Billed to" description="Snapshot at issue time" />
              <CardBody className="space-y-1 text-sm">
                <p className="font-medium text-ink">{snapshot.customer_name ?? '—'}</p>
                {snapshot.phone && <p className="text-muted">{snapshot.phone}</p>}
                {snapshot.email && <p className="text-muted">{snapshot.email}</p>}
                {snapshot.gstin && <p className="text-muted">GSTIN {snapshot.gstin}</p>}
                {snapshot.billing_address && <p className="text-muted">{snapshot.billing_address}</p>}
              </CardBody>
            </Card>
          )}

          {invoice.document_state === 'issued' && canManageBusiness && derived.allocated === 0n && (
            <Card>
              <CardHeader title="Void invoice" description="Only possible with no payments" />
              <CardBody className="space-y-3">
                {showVoid ? (
                  <>
                    <textarea
                      rows={2}
                      value={voidReason}
                      onChange={(event) => setVoidReason(event.target.value)}
                      placeholder="Reason for voiding"
                      className="w-full rounded-lg border border-line px-3 py-2 text-sm focus:border-navy-500 focus:outline-none focus:ring-2 focus:ring-navy-500/20"
                    />
                    <div className="flex gap-2">
                      <Button size="sm" variant="danger" loading={busy} onClick={() => void handleVoid()}>
                        Confirm void
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setShowVoid(false)}>
                        Cancel
                      </Button>
                    </div>
                  </>
                ) : (
                  <Button size="sm" variant="danger" onClick={() => setShowVoid(true)}>
                    Void this invoice
                  </Button>
                )}
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className="text-right text-ink">{value}</span>
    </div>
  );
}
