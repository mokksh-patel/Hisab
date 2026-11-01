import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useBusiness } from '@/context/BusinessContext';
import { listCustomers } from '@/services/customerService';
import { createInvoice, issueInvoice } from '@/services/invoiceService';
import { toAppError } from '@/lib/errors';
import { addDays, todayInTimeZone } from '@/lib/dateUtils';
import { parseRupeesToPaise, tryParseRupeesToPaise, type Paise } from '@/lib/money';
import {
  calculateInvoiceTotals,
  type GstMode,
  type InvoiceLineInput,
} from '@/lib/invoiceCalculations';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { CurrencyDisplay } from '@/components/ui/CurrencyDisplay';
import { useToast } from '@/components/ui/Toast';
import { ErrorState } from '@/components/ui/States';

interface LineDraft {
  key: string;
  description: string;
  hsnSac: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  discountPercent: string;
  taxRatePercent: string;
}

let lineCounter = 0;
function newLine(): LineDraft {
  lineCounter += 1;
  return {
    key: `line-${lineCounter}`,
    description: '',
    hsnSac: '',
    quantity: '1',
    unit: '',
    unitPrice: '',
    discountPercent: '0',
    taxRatePercent: '18',
  };
}

const GST_MODE_OPTIONS = [
  { value: 'intra_state', label: 'Intra-state (CGST + SGST)' },
  { value: 'inter_state', label: 'Inter-state (IGST)' },
  { value: 'exempt', label: 'Exempt / no GST' },
];

export default function CreateInvoicePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { currentBusinessId, currentBusiness, canWriteFinancials } = useBusiness();
  const today = todayInTimeZone(currentBusiness?.timezone ?? 'Asia/Kolkata');

  const [customerId, setCustomerId] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(today);
  const [dueDate, setDueDate] = useState(
    addDays(today, currentBusiness?.default_credit_period_days ?? 30),
  );
  const [gstMode, setGstMode] = useState<GstMode>('intra_state');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<'draft' | 'issue' | null>(null);

  const customersQuery = useQuery({
    queryKey: ['customers', currentBusinessId],
    queryFn: () => listCustomers(currentBusinessId!),
    enabled: Boolean(currentBusinessId),
  });

  const customerOptions = useMemo(
    () => [
      { value: '', label: 'Select a customer' },
      ...(customersQuery.data ?? []).map((customer) => ({
        value: customer.id,
        label: customer.customer_name,
      })),
    ],
    [customersQuery.data],
  );

  /** Live preview totals. The database recomputes these on save. */
  const preview = useMemo(() => {
    const parsed: InvoiceLineInput[] = [];
    for (const line of lines) {
      const price = tryParseRupeesToPaise(line.unitPrice);
      if (price === null || line.description.trim() === '') continue;
      parsed.push({
        key: line.key,
        description: line.description,
        hsnSac: line.hsnSac || null,
        quantity: line.quantity || '0',
        unit: line.unit || null,
        unitPricePaise: price,
        discountPercent: line.discountPercent || '0',
        taxRatePercent: line.taxRatePercent || '0',
      });
    }
    if (parsed.length === 0) return null;
    try {
      return calculateInvoiceTotals(parsed, gstMode);
    } catch {
      return null;
    }
  }, [lines, gstMode]);

  function updateLine(key: string, patch: Partial<LineDraft>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function removeLine(key: string) {
    setLines((current) => (current.length === 1 ? current : current.filter((line) => line.key !== key)));
  }

  async function handleSubmit(mode: 'draft' | 'issue') {
    setFormError(null);

    if (!customerId) {
      setFormError('Select a customer for this invoice.');
      return;
    }
    if (dueDate < invoiceDate) {
      setFormError('The due date cannot be before the invoice date.');
      return;
    }

    const payloadLines = [];
    for (const [index, line] of lines.entries()) {
      if (line.description.trim() === '') continue;
      let price: Paise;
      try {
        price = parseRupeesToPaise(line.unitPrice);
      } catch {
        setFormError(`Line ${index + 1}: enter a valid unit price.`);
        return;
      }
      payloadLines.push({
        description: line.description.trim(),
        hsn_sac: line.hsnSac.trim() || null,
        quantity: line.quantity.trim() || '1',
        unit: line.unit.trim() || null,
        unit_price_paise: price.toString(),
        discount_percent_basis_points: Math.round(Number(line.discountPercent || '0') * 100),
        tax_rate_basis_points: Math.round(Number(line.taxRatePercent || '0') * 100),
        cess_rate_basis_points: 0,
      });
    }

    if (payloadLines.length === 0) {
      setFormError('Add at least one line item with a description and price.');
      return;
    }

    setSubmitting(mode);
    try {
      const invoiceId = await createInvoice({
        businessId: currentBusinessId!,
        customerId,
        invoiceDate,
        dueDate,
        gstMode,
        placeOfSupplyStateCode: currentBusiness?.state_code ?? null,
        lines: payloadLines,
        notes: notes.trim() || null,
      });

      if (mode === 'issue') {
        await issueInvoice(invoiceId);
        toast.success('Invoice issued.');
      } else {
        toast.success('Draft saved.');
      }

      await queryClient.invalidateQueries({ queryKey: ['invoices'] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
      navigate(`/invoices/${invoiceId}`, { replace: true });
    } catch (error) {
      setFormError(toAppError(error).message);
    } finally {
      setSubmitting(null);
    }
  }

  if (!canWriteFinancials) {
    return (
      <div className="space-y-5">
        <PageHeader title="Create invoice" />
        <Card>
          <ErrorState message="Your role does not allow creating invoices. Ask an owner or accountant for access." />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Create invoice"
        description="Totals are recalculated by the database when you save."
      />

      {formError && (
        <div role="alert" className="rounded-lg border border-coral-100 bg-coral-50 px-3 py-2 text-sm text-coral-700">
          {formError}
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          {/* Customer + invoice info */}
          <Card>
            <CardHeader title="Customer and dates" />
            <CardBody className="space-y-4">
              <Select
                label="Customer"
                options={customerOptions}
                value={customerId}
                onChange={(event) => setCustomerId(event.target.value)}
                hint={
                  customersQuery.data?.length === 0
                    ? 'No customers yet — add one from the Customers page first.'
                    : undefined
                }
              />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Input
                  label="Invoice date"
                  type="date"
                  value={invoiceDate}
                  onChange={(event) => setInvoiceDate(event.target.value)}
                />
                <Input
                  label="Due date"
                  type="date"
                  value={dueDate}
                  onChange={(event) => setDueDate(event.target.value)}
                  error={dueDate < invoiceDate ? 'Due date cannot be before the invoice date' : undefined}
                />
              </div>
              <Select
                label="GST treatment"
                options={GST_MODE_OPTIONS}
                value={gstMode}
                onChange={(event) => setGstMode(event.target.value as GstMode)}
                hint={`Suggested from your state (${currentBusiness?.state_code ?? 'not set'}).`}
              />
            </CardBody>
          </Card>

          {/* Line items */}
          <Card>
            <CardHeader
              title="Line items"
              action={
                <Button size="sm" variant="secondary" onClick={() => setLines((c) => [...c, newLine()])}>
                  <Plus className="size-4" aria-hidden="true" />
                  Add line
                </Button>
              }
            />
            <CardBody className="space-y-4">
              {lines.map((line, index) => (
                <div key={line.key} className="rounded-lg border border-line p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-xs font-medium text-muted">Line {index + 1}</p>
                    <button
                      type="button"
                      onClick={() => removeLine(line.key)}
                      disabled={lines.length === 1}
                      className="rounded p-1 text-muted hover:bg-coral-50 hover:text-coral-700 disabled:opacity-40"
                      aria-label={`Remove line ${index + 1}`}
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                  <div className="space-y-3">
                    <Input
                      label="Description"
                      placeholder="Item or service"
                      value={line.description}
                      onChange={(event) => updateLine(line.key, { description: event.target.value })}
                    />
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <Input
                        label="HSN/SAC"
                        placeholder="Optional"
                        value={line.hsnSac}
                        onChange={(event) => updateLine(line.key, { hsnSac: event.target.value })}
                      />
                      <Input
                        label="Quantity"
                        inputMode="decimal"
                        value={line.quantity}
                        onChange={(event) => updateLine(line.key, { quantity: event.target.value })}
                      />
                      <Input
                        label="Unit"
                        placeholder="pcs"
                        value={line.unit}
                        onChange={(event) => updateLine(line.key, { unit: event.target.value })}
                      />
                      <Input
                        label="Unit price (₹)"
                        inputMode="decimal"
                        placeholder="0.00"
                        value={line.unitPrice}
                        onChange={(event) => updateLine(line.key, { unitPrice: event.target.value })}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <Input
                        label="Discount %"
                        inputMode="decimal"
                        value={line.discountPercent}
                        onChange={(event) => updateLine(line.key, { discountPercent: event.target.value })}
                      />
                      <Input
                        label="GST rate %"
                        inputMode="decimal"
                        value={line.taxRatePercent}
                        onChange={(event) => updateLine(line.key, { taxRatePercent: event.target.value })}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Notes" />
            <CardBody>
              <Textarea
                rows={3}
                placeholder="Optional notes shown on the invoice"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </CardBody>
          </Card>
        </div>

        {/* Summary */}
        <div className="xl:col-span-1">
          <Card className="xl:sticky xl:top-20">
            <CardHeader title="Summary" description="Live preview" />
            <CardBody className="space-y-2 text-sm">
              {preview ? (
                <>
                  <Row label="Subtotal" value={<CurrencyDisplay value={preview.subtotalPaise} />} />
                  {preview.discountPaise > 0n && (
                    <Row label="Discount" value={<CurrencyDisplay value={preview.discountPaise} />} />
                  )}
                  <Row label="Taxable value" value={<CurrencyDisplay value={preview.taxableAmountPaise} />} />
                  {preview.cgstPaise > 0n && (
                    <Row label="CGST" value={<CurrencyDisplay value={preview.cgstPaise} />} />
                  )}
                  {preview.sgstPaise > 0n && (
                    <Row label="SGST" value={<CurrencyDisplay value={preview.sgstPaise} />} />
                  )}
                  {preview.igstPaise > 0n && (
                    <Row label="IGST" value={<CurrencyDisplay value={preview.igstPaise} />} />
                  )}
                  {preview.cessPaise > 0n && (
                    <Row label="Cess" value={<CurrencyDisplay value={preview.cessPaise} />} />
                  )}
                  <div className="mt-2 flex items-center justify-between border-t border-line pt-2 text-base font-semibold">
                    <span>Total</span>
                    <CurrencyDisplay value={preview.totalAmountPaise} />
                  </div>
                </>
              ) : (
                <p className="py-4 text-center text-sm text-muted">
                  Add a line item with a description and price to see totals.
                </p>
              )}

              <div className="mt-4 space-y-2">
                <Button
                  fullWidth
                  loading={submitting === 'issue'}
                  disabled={submitting !== null}
                  onClick={() => void handleSubmit('issue')}
                >
                  Issue invoice
                </Button>
                <Button
                  fullWidth
                  variant="secondary"
                  loading={submitting === 'draft'}
                  disabled={submitting !== null}
                  onClick={() => void handleSubmit('draft')}
                >
                  Save as draft
                </Button>
              </div>
              <p className="mt-2 text-center text-xs text-muted">
                An issued invoice cannot be edited. Void it and issue a corrected one instead.
              </p>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted">{label}</span>
      <span className="text-ink">{value}</span>
    </div>
  );
}
