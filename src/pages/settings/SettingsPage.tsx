import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useBusiness } from '@/context/BusinessContext';
import { updateBusiness } from '@/services/businessService';
import { toAppError } from '@/lib/errors';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { currentBusiness, canManageBusiness } = useBusiness();

  const [displayName, setDisplayName] = useState(currentBusiness?.display_name ?? '');
  const [legalName, setLegalName] = useState(currentBusiness?.legal_name ?? '');
  const [invoicePrefix, setInvoicePrefix] = useState(currentBusiness?.invoice_prefix ?? 'INV');
  const [creditDays, setCreditDays] = useState(String(currentBusiness?.default_credit_period_days ?? 30));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!currentBusiness) return null;

  async function handleSave() {
    setError(null);
    if (!canManageBusiness) {
      setError('Only an owner or administrator can change business settings.');
      return;
    }
    setSaving(true);
    try {
      await updateBusiness(currentBusiness!.id, {
        display_name: displayName.trim(),
        legal_name: legalName.trim(),
        invoice_prefix: invoicePrefix.trim().toUpperCase(),
        default_credit_period_days: Number(creditDays),
      });
      toast.success('Settings saved.');
      await queryClient.invalidateQueries({ queryKey: ['my-businesses'] });
    } catch (err) {
      setError(toAppError(err).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Settings" description="Business details used on invoices and reminders." />

      {error && (
        <div role="alert" className="rounded-lg border border-coral-100 bg-coral-50 px-3 py-2 text-sm text-coral-700">
          {error}
        </div>
      )}

      <Card>
        <CardHeader title="Business profile" />
        <CardBody className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label="Display name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              disabled={!canManageBusiness}
            />
            <Input
              label="Legal name"
              value={legalName}
              onChange={(event) => setLegalName(event.target.value)}
              disabled={!canManageBusiness}
            />
            <Input
              label="Invoice prefix"
              value={invoicePrefix}
              onChange={(event) => setInvoicePrefix(event.target.value)}
              disabled={!canManageBusiness}
              hint="Used for new invoice numbers"
            />
            <Input
              label="Default credit period (days)"
              type="number"
              min={0}
              max={365}
              value={creditDays}
              onChange={(event) => setCreditDays(event.target.value)}
              disabled={!canManageBusiness}
            />
          </div>

          <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-muted">
            <p>GSTIN: {currentBusiness.gstin ?? 'Not set'}</p>
            <p>State code: {currentBusiness.state_code ?? 'Not set'}</p>
            <p>Currency: {currentBusiness.currency} · Time zone: {currentBusiness.timezone}</p>
          </div>

          {canManageBusiness ? (
            <Button size="sm" loading={saving} onClick={() => void handleSave()}>
              Save changes
            </Button>
          ) : (
            <p className="text-xs text-muted">
              Your role is read-only for business settings.
            </p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
