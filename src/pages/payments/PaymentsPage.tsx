import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useBusiness } from '@/context/BusinessContext';
import { listCustomers } from '@/services/customerService';
import { listOpenInvoicesForCustomer } from '@/services/invoiceService';
import { listPayments, newIdempotencyKey, recordPayment, reversePayment } from '@/services/paymentService';
import { toAppError } from '@/lib/errors';
import { todayInTimeZone, formatDate } from '@/lib/dateUtils';
import { parsePaise, parseRupeesToPaise, type Paise } from '@/lib/money';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { CurrencyDisplay } from '@/components/ui/CurrencyDisplay';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import type { PaymentMethod } from '@/types/database';

const METHOD_OPTIONS = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'card', label: 'Card' },
  { value: 'other', label: 'Other' },
];

export default function PaymentsPage() {
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { currentBusinessId, currentBusiness, canWriteFinancials, canManageBusiness } = useBusiness();
  const today = todayInTimeZone(currentBusiness?.timezone ?? 'Asia/Kolkata');

  const [showForm, setShowForm] = useState(Boolean(searchParams.get('customer')));
  const [customerId, setCustomerId] = useState(searchParams.get('customer') ?? '');
  const [amount, setAmount] = useState('');
  const [paymentDate, setPaymentDate] = useState(today);
  const [method, setMethod] = useState<PaymentMethod>('upi');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [allocateTo, setAllocateTo] = useState(searchParams.get('invoice') ?? '');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // One idempotency key per form session: a double submit cannot create two payments.
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey());

  const customersQuery = useQuery({
    queryKey: ['customers', currentBusinessId],
    queryFn: () => listCustomers(currentBusinessId!),
    enabled: Boolean(currentBusinessId),
  });

  const openInvoicesQuery = useQuery({
    queryKey: ['open-invoices', customerId],
    queryFn: () => listOpenInvoicesForCustomer(customerId),
    enabled: Boolean(customerId),
  });

  const paymentsQuery = useQuery({
    queryKey: ['payments', currentBusinessId],
    queryFn: () => listPayments(currentBusinessId!, { limit: 50 }),
    enabled: Boolean(currentBusinessId),
  });

  const customerOptions = useMemo(
    () => [
      { value: '', label: 'Select a customer' },
      ...(customersQuery.data ?? []).map((c) => ({ value: c.id, label: c.customer_name })),
    ],
    [customersQuery.data],
  );

  const invoiceOptions = useMemo(
    () => [
      { value: '', label: 'Leave unallocated (advance)' },
      ...(openInvoicesQuery.data ?? []).map((invoice) => ({
        value: invoice.invoice_id,
        label: `${invoice.invoice_number} — ${formatDate(invoice.due_date)}`,
      })),
    ],
    [openInvoicesQuery.data],
  );

  const selectedInvoice = (openInvoicesQuery.data ?? []).find((i) => i.invoice_id === allocateTo);

  function resetForm() {
    setAmount('');
    setReference('');
    setNotes('');
    setAllocateTo('');
    setFormError(null);
    setIdempotencyKey(newIdempotencyKey());
  }

  async function handleSubmit() {
    setFormError(null);

    if (!customerId) {
      setFormError('Select a customer.');
      return;
    }

    let amountPaise: Paise;
    try {
      amountPaise = parseRupeesToPaise(amount);
    } catch {
      setFormError('Enter a valid amount.');
      return;
    }
    if (amountPaise <= 0n) {
      setFormError('Amount must be greater than zero.');
      return;
    }

    const allocations = allocateTo
      ? [{ invoice_id: allocateTo, amount_paise: amountPaise.toString() }]
      : [];

    setSaving(true);
    try {
      await recordPayment({
        businessId: currentBusinessId!,
        customerId,
        paymentDate,
        amountPaise,
        paymentMethod: method,
        referenceNumber: reference.trim() || null,
        notes: notes.trim() || null,
        allocations,
        idempotencyKey,
      });
      toast.success('Payment recorded.');
      resetForm();
      setShowForm(false);
      await queryClient.invalidateQueries({ queryKey: ['payments'] });
      await queryClient.invalidateQueries({ queryKey: ['invoices'] });
      await queryClient.invalidateQueries({ queryKey: ['invoice-balance'] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
      await queryClient.invalidateQueries({ queryKey: ['customer-receivables'] });
    } catch (error) {
      setFormError(toAppError(error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleReverse(paymentId: string) {
    const reason = window.prompt('Reason for reversing this payment:');
    if (!reason || reason.trim() === '') return;
    try {
      await reversePayment(paymentId, reason.trim());
      toast.success('Payment reversed.');
      await queryClient.invalidateQueries({ queryKey: ['payments'] });
      await queryClient.invalidateQueries({ queryKey: ['invoices'] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
    } catch (error) {
      toast.error(toAppError(error).message);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Payments"
        description="Every receipt, its allocation and any unallocated balance."
        actions={
          canWriteFinancials ? (
            <Button size="sm" onClick={() => setShowForm((open) => !open)}>
              <Plus className="size-4" aria-hidden="true" />
              Record payment
            </Button>
          ) : undefined
        }
      />

      {showForm && (
        <Card>
          <CardHeader title="Record a payment" description="Allocations are validated by the database." />
          <CardBody className="space-y-4">
            {formError && (
              <div role="alert" className="rounded-lg border border-coral-100 bg-coral-50 px-3 py-2 text-sm text-coral-700">
                {formError}
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Select
                label="Customer"
                options={customerOptions}
                value={customerId}
                onChange={(event) => {
                  setCustomerId(event.target.value);
                  setAllocateTo('');
                }}
              />
              <Input
                label="Amount (₹)"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
              <Input
                label="Payment date"
                type="date"
                value={paymentDate}
                onChange={(event) => setPaymentDate(event.target.value)}
              />
              <Select
                label="Method"
                options={METHOD_OPTIONS}
                value={method}
                onChange={(event) => setMethod(event.target.value as PaymentMethod)}
              />
              <Input
                label="Reference (optional)"
                placeholder="UPI / cheque number"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
              />
              <Select
                label="Allocate to invoice"
                options={invoiceOptions}
                value={allocateTo}
                onChange={(event) => setAllocateTo(event.target.value)}
                hint={
                  selectedInvoice
                    ? `Outstanding: ${parsePaise(selectedInvoice.outstanding_paise).toString()} paise`
                    : 'Unallocated amounts are kept as an advance.'
                }
              />
            </div>

            <Textarea
              label="Notes (optional)"
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />

            <div className="flex gap-2">
              <Button size="sm" loading={saving} onClick={() => void handleSubmit()}>
                Save payment
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  resetForm();
                  setShowForm(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        {paymentsQuery.isError ? (
          <ErrorState message="Could not load payments." onRetry={() => void paymentsQuery.refetch()} />
        ) : paymentsQuery.isLoading ? (
          <TableSkeleton rows={6} columns={5} />
        ) : (paymentsQuery.data ?? []).length === 0 ? (
          <EmptyState
            title="No payments yet"
            description="Record a payment to see it here with its allocation."
            action={
              canWriteFinancials ? (
                <Button size="sm" onClick={() => setShowForm(true)}>
                  <Plus className="size-4" aria-hidden="true" />
                  Record payment
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs font-medium text-muted">
                  <th scope="col" className="px-4 py-2.5 sm:px-5">Date</th>
                  <th scope="col" className="px-4 py-2.5">Method</th>
                  <th scope="col" className="px-4 py-2.5">Reference</th>
                  <th scope="col" className="px-4 py-2.5 text-right">Amount</th>
                  <th scope="col" className="px-4 py-2.5 text-right">Allocated</th>
                  <th scope="col" className="px-4 py-2.5 text-right">Unallocated</th>
                  <th scope="col" className="px-4 py-2.5 sm:px-5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {paymentsQuery.data!.map((payment) => {
                  const reversed = payment.reversed_at !== null;
                  return (
                    <tr key={payment.payment_id} className={reversed ? 'opacity-60' : 'hover:bg-slate-50'}>
                      <td className="px-4 py-3 text-ink sm:px-5">{formatDate(payment.payment_date)}</td>
                      <td className="px-4 py-3 text-muted">{payment.payment_method.replace('_', ' ')}</td>
                      <td className="px-4 py-3 text-muted">{payment.reference_number ?? '—'}</td>
                      <td className="px-4 py-3 text-right">
                        <CurrencyDisplay value={parsePaise(payment.amount_paise)} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <CurrencyDisplay value={parsePaise(payment.allocated_paise)} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <CurrencyDisplay
                          value={parsePaise(payment.unallocated_paise)}
                          muted={parsePaise(payment.unallocated_paise) === 0n}
                        />
                      </td>
                      <td className="px-4 py-3 text-right sm:px-5">
                        {reversed ? (
                          <span className="text-xs text-muted">Reversed</span>
                        ) : canManageBusiness ? (
                          <button
                            type="button"
                            onClick={() => void handleReverse(payment.payment_id)}
                            className="text-xs font-medium text-coral-700 hover:underline"
                          >
                            Reverse
                          </button>
                        ) : null}
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
