import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { Building2 } from 'lucide-react';
import { createBusiness } from '@/services/businessService';
import { toAppError } from '@/lib/errors';
import { useAuth } from '@/context/AuthContext';
import { useBusiness } from '@/context/BusinessContext';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { AuthLayout } from '@/pages/auth/AuthLayout';

/** Indian state codes used for GST place-of-supply. */
const STATE_OPTIONS = [
  { value: '', label: 'Select state' },
  { value: '07', label: 'Delhi (07)' },
  { value: '09', label: 'Uttar Pradesh (09)' },
  { value: '19', label: 'West Bengal (19)' },
  { value: '23', label: 'Madhya Pradesh (23)' },
  { value: '24', label: 'Gujarat (24)' },
  { value: '27', label: 'Maharashtra (27)' },
  { value: '29', label: 'Karnataka (29)' },
  { value: '32', label: 'Kerala (32)' },
  { value: '33', label: 'Tamil Nadu (33)' },
  { value: '36', label: 'Telangana (36)' },
  { value: '37', label: 'Andhra Pradesh (37)' },
];

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

const schema = z.object({
  legalName: z.string().trim().min(1, 'Legal name is required').max(200),
  displayName: z.string().trim().min(1, 'Display name is required').max(120),
  businessType: z.string().trim().max(80).optional(),
  gstin: z
    .string()
    .trim()
    .optional()
    .refine((value) => !value || GSTIN_RE.test(value.toUpperCase()), {
      message: 'Enter a valid 15-character GSTIN',
    }),
  city: z.string().trim().max(80).optional(),
  stateCode: z.string().optional(),
  phone: z.string().trim().max(20).optional(),
  email: z.string().trim().optional().refine((v) => !v || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), {
    message: 'Enter a valid email address',
  }),
  /**
   * GST scheme is chosen explicitly. It is never inferred from the GSTIN,
   * because a composition taxpayer is also GST-registered but may not issue
   * tax invoices.
   */
  gstScheme: z.enum(['unregistered', 'regular', 'composition']),
  invoicePrefix: z
    .string()
    .trim()
    .min(1, 'Prefix is required')
    .max(10, 'Use at most 10 characters'),
  defaultCreditPeriodDays: z
    .string()
    .trim()
    .min(1, 'Enter a number of days')
    .refine((value) => /^\d{1,3}$/.test(value) && Number(value) >= 0 && Number(value) <= 365, {
      message: 'Enter a whole number between 0 and 365',
    }),
});

type FormValues = z.infer<typeof schema>;

export function OnboardingPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { user, signOut } = useAuth();
  const { businesses, selectBusiness } = useBusiness();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      legalName: '',
      displayName: '',
      businessType: '',
      gstin: '',
      city: '',
      stateCode: '',
      phone: '',
      email: '',
      gstScheme: 'unregistered',
      invoicePrefix: 'INV',
      defaultCreditPeriodDays: '30',
    },
  });

  const gstin = watch('gstin') ?? '';
  const gstScheme = watch('gstScheme');

  async function onSubmit(values: FormValues) {
    setFormError(null);
    try {
      const businessId = await createBusiness({
        legalName: values.legalName,
        displayName: values.displayName,
        businessType: values.businessType || null,
        gstin: values.gstin ? values.gstin.toUpperCase() : null,
        city: values.city || null,
        stateCode: values.stateCode || null,
        phone: values.phone || null,
        email: values.email || null,
        isGstRegistered: values.gstScheme !== 'unregistered',
        // The scheme is chosen explicitly. The server never assumes 'regular'
        // for a registered business, because a composition taxpayer is also
        // registered but may not issue tax invoices.
        gstScheme: values.gstScheme,
        invoicePrefix: values.invoicePrefix.toUpperCase(),
        defaultCreditPeriodDays: Number(values.defaultCreditPeriodDays),
      });

      // Refetch BEFORE selecting, so the context's "is this id valid?" effect
      // sees the new business. Selecting first races the refetch: the effect
      // runs against a stale list, decides the id is invalid, and overwrites it.
      await queryClient.refetchQueries({ queryKey: ['my-businesses'] });
      selectBusiness(businessId);
      toast.success('Business created. Welcome to BizPilot.');
      navigate('/', { replace: true });
    } catch (error) {
      setFormError(toAppError(error).message);
    }
  }

  return (
    <AuthLayout
      title={businesses.length > 0 ? 'Add another business' : 'Set up your business'}
      subtitle="This information appears on your invoices. You can change it later in Settings."
      footer={
        <button
          type="button"
          onClick={() => void signOut()}
          className="text-sm text-muted hover:text-ink hover:underline"
        >
          Sign out ({user?.email})
        </button>
      }
    >
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
        {formError && (
          <div role="alert" className="rounded-lg border border-coral-100 bg-coral-50 px-3 py-2 text-sm text-coral-700">
            {formError}
          </div>
        )}

        <Input
          label="Legal business name"
          placeholder="As registered, e.g. Sharma Traders Pvt Ltd"
          error={errors.legalName?.message}
          {...register('legalName')}
        />

        <Input
          label="Display name"
          placeholder="Short name shown in the app"
          error={errors.displayName?.message}
          {...register('displayName')}
        />

        <Input
          label="Business type (optional)"
          placeholder="e.g. Wholesaler, Manufacturer"
          error={errors.businessType?.message}
          {...register('businessType')}
        />

        <Select
          label="GST registration"
          options={[
            { value: 'unregistered', label: 'Not registered for GST' },
            { value: 'regular', label: 'Regular GST registration' },
            { value: 'composition', label: 'Composition scheme' },
          ]}
          hint={
            gstScheme === 'composition'
              ? 'Composition businesses cannot issue tax invoices or collect GST.'
              : gstScheme === 'regular'
                ? 'You can issue tax invoices with CGST/SGST or IGST.'
                : 'You cannot charge GST on invoices.'
          }
          error={errors.gstScheme?.message}
          {...register('gstScheme')}
        />

        {gstScheme !== 'unregistered' && (
          <Input
            label="GSTIN"
            placeholder="22AAAAA0000A1Z5"
            hint="Format is validated only — this does not verify the GSTIN with the GST portal."
            error={errors.gstin?.message}
            {...register('gstin')}
          />
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="City (optional)"
            placeholder="e.g. Ahmedabad"
            error={errors.city?.message}
            {...register('city')}
          />
          <Select
            label="State (optional)"
            options={STATE_OPTIONS}
            error={errors.stateCode?.message}
            {...register('stateCode')}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Phone (optional)"
            placeholder="+91 98765 43210"
            error={errors.phone?.message}
            {...register('phone')}
          />
          <Input
            label="Email (optional)"
            type="email"
            placeholder="accounts@business.com"
            error={errors.email?.message}
            {...register('email')}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Invoice prefix"
            placeholder="INV"
            hint="Used for invoice numbers, e.g. INV-2026-27-001"
            error={errors.invoicePrefix?.message}
            {...register('invoicePrefix')}
          />
          <Input
            label="Default credit period (days)"
            type="number"
            min={0}
            max={365}
            error={errors.defaultCreditPeriodDays?.message}
            {...register('defaultCreditPeriodDays')}
          />
        </div>

        {gstScheme === 'composition' && (
          <p className="rounded-lg bg-warning-50 px-3 py-2 text-xs text-warning-700">
            Composition businesses cannot issue tax invoices or collect GST from customers.
            Bill of Supply is not yet supported in BizPilot.
          </p>
        )}

        {gstScheme === 'regular' && !gstin && (
          <p className="rounded-lg bg-warning-50 px-3 py-2 text-xs text-warning-700">
            Add your GSTIN so it appears on the tax invoices you issue.
          </p>
        )}

        <Button type="submit" fullWidth loading={isSubmitting}>
          {isSubmitting ? 'Creating business…' : 'Create business'}
        </Button>

        <p className="flex items-center justify-center gap-1.5 text-xs text-muted">
          <Building2 className="size-3.5" aria-hidden="true" />
          You will be the owner of this business.
        </p>
      </form>
    </AuthLayout>
  );
}
