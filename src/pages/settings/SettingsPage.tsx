import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useBusiness } from '@/context/BusinessContext';
import { confirmGstScheme, updateBusiness } from '@/services/businessService';
import { toAppError } from '@/lib/errors';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Input, Select } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import type { GstScheme } from '@/types/database';

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { currentBusiness, canManageBusiness } = useBusiness();

  const [displayName, setDisplayName] = useState(currentBusiness?.display_name ?? '');
  const [legalName, setLegalName] = useState(currentBusiness?.legal_name ?? '');
  const [invoicePrefix, setInvoicePrefix] = useState(currentBusiness?.invoice_prefix ?? 'INV');
  const [creditDays, setCreditDays] = useState(String(currentBusiness?.default_credit_period_days ?? 30));
  const [gstScheme, setGstScheme] = useState(currentBusiness?.gst_scheme ?? 'unregistered');
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

      // The GST scheme goes through a dedicated RPC so the server can enforce
      // owner/admin authorisation, keep is_gst_registered consistent, clear the
      // review flag and write an audit record.
      if (gstScheme !== currentBusiness!.gst_scheme || currentBusiness!.gst_scheme_needs_review) {
        await confirmGstScheme(currentBusiness!.id, gstScheme);
      }

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

          {currentBusiness.gst_scheme_needs_review && (
            <div
              role="status"
              className="rounded-lg border border-warning-100 bg-warning-50 px-3 py-2 text-xs text-warning-700"
            >
              Your GST scheme was set to <strong>Regular</strong> automatically during an upgrade.
              Please confirm it below — a composition-scheme business must not issue tax invoices.
            </div>
          )}

          <Select
            label="GST scheme"
            options={[
              { value: 'unregistered', label: 'Not registered for GST' },
              { value: 'regular', label: 'Regular GST registration' },
              { value: 'composition', label: 'Composition scheme' },
            ]}
            value={gstScheme}
            onChange={(event) => setGstScheme(event.target.value as GstScheme)}
            disabled={!canManageBusiness}
            hint={
              gstScheme === 'composition'
                ? 'Composition businesses cannot issue tax invoices — use exempt supply.'
                : gstScheme === 'unregistered'
                  ? 'Unregistered businesses cannot charge GST on invoices.'
                  : 'Regular businesses may issue tax invoices with CGST/SGST or IGST.'
            }
          />

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
