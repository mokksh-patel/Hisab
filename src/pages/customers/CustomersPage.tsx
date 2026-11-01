import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useBusiness } from '@/context/BusinessContext';
import { createCustomer, listCustomerReceivables } from '@/services/customerService';
import { toAppError } from '@/lib/errors';
import { parsePaise } from '@/lib/money';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CurrencyDisplay } from '@/components/ui/CurrencyDisplay';
import { Input } from '@/components/ui/Input';
import { SearchInput } from '@/components/ui/SearchInput';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';

export default function CustomersPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { currentBusinessId, canWriteFinancials } = useBusiness();

  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [gstin, setGstin] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['customer-receivables', currentBusinessId],
    queryFn: () => listCustomerReceivables(currentBusinessId!),
    enabled: Boolean(currentBusinessId),
  });

  const rows = useMemo(() => {
    const all = query.data ?? [];
    const term = search.trim().toLowerCase();
    if (!term) return all;
    return all.filter(
      (row) =>
        row.customer_name.toLowerCase().includes(term) ||
        (row.phone ?? '').toLowerCase().includes(term) ||
        (row.email ?? '').toLowerCase().includes(term),
    );
  }, [query.data, search]);

  async function handleCreate() {
    setFormError(null);
    if (name.trim() === '') {
      setFormError('Customer name is required.');
      return;
    }
    setSaving(true);
    try {
      await createCustomer(currentBusinessId!, {
        customer_name: name,
        phone: phone || null,
        email: email || null,
        gstin: gstin || null,
      });
      toast.success('Customer added.');
      setName('');
      setPhone('');
      setEmail('');
      setGstin('');
      setShowForm(false);
      await queryClient.invalidateQueries({ queryKey: ['customer-receivables'] });
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
    } catch (error) {
      setFormError(toAppError(error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Customers"
        description="Balances are derived from issued invoices and live allocations."
        actions={
          canWriteFinancials ? (
            <Button size="sm" onClick={() => setShowForm((open) => !open)}>
              <Plus className="size-4" aria-hidden="true" />
              Add customer
            </Button>
          ) : undefined
        }
      />

      {showForm && (
        <Card className="p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-ink">New customer</h2>
          {formError && (
            <div role="alert" className="mt-3 rounded-lg border border-coral-100 bg-coral-50 px-3 py-2 text-sm text-coral-700">
              {formError}
            </div>
          )}
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label="Customer name" value={name} onChange={(e) => setName(e.target.value)} />
            <Input label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" />
            <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <Input label="GSTIN" value={gstin} onChange={(e) => setGstin(e.target.value)} placeholder="Optional" />
          </div>
          <div className="mt-4 flex gap-2">
            <Button size="sm" loading={saving} onClick={() => void handleCreate()}>
              Save customer
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder="Search by name, phone or email"
        className="sm:max-w-sm"
      />

      <Card>
        {query.isError ? (
          <ErrorState message="Could not load customers." onRetry={() => void query.refetch()} />
        ) : query.isLoading ? (
          <TableSkeleton rows={6} columns={5} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={search ? 'No matching customers' : 'No customers yet'}
            description={
              search
                ? 'Try a different search term.'
                : 'Add your first customer to start creating invoices.'
            }
            action={
              !search && canWriteFinancials ? (
                <Button size="sm" onClick={() => setShowForm(true)}>
                  <Plus className="size-4" aria-hidden="true" />
                  Add customer
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs font-medium text-muted">
                  <th scope="col" className="px-4 py-2.5 sm:px-5">Customer</th>
                  <th scope="col" className="px-4 py-2.5">Phone</th>
                  <th scope="col" className="px-4 py-2.5 text-right">Invoiced</th>
                  <th scope="col" className="px-4 py-2.5 text-right">Outstanding</th>
                  <th scope="col" className="px-4 py-2.5 text-right sm:px-5">Overdue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((row) => {
                  const outstanding = parsePaise(row.outstanding_paise);
                  const overdue = parsePaise(row.overdue_paise);
                  return (
                    <tr key={row.customer_id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 sm:px-5">
                        <Link
                          to={`/customers/${row.customer_id}`}
                          className="font-medium text-navy-700 hover:underline"
                        >
                          {row.customer_name}
                        </Link>
                        {row.gstin && <span className="ml-2 text-xs text-muted">{row.gstin}</span>}
                      </td>
                      <td className="px-4 py-3 text-muted">{row.phone ?? '—'}</td>
                      <td className="px-4 py-3 text-right">
                        <CurrencyDisplay value={parsePaise(row.total_invoiced_paise)} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <CurrencyDisplay value={outstanding} muted={outstanding === 0n} />
                      </td>
                      <td className="px-4 py-3 text-right sm:px-5">
                        <CurrencyDisplay
                          value={overdue}
                          muted={overdue === 0n}
                          className={overdue > 0n ? 'font-medium text-coral-700' : undefined}
                        />
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
