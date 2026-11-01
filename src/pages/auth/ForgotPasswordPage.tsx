import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { MailCheck } from 'lucide-react';
import { requestPasswordReset } from '@/services/authService';
import { toAppError } from '@/lib/errors';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { AuthLayout } from './AuthLayout';

const schema = z.object({
  email: z.string().trim().min(1, 'Email is required').email('Enter a valid email address'),
});

type FormValues = z.infer<typeof schema>;

export function ForgotPasswordPage() {
  const [formError, setFormError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '' },
  });

  async function onSubmit(values: FormValues) {
    setFormError(null);
    try {
      await requestPasswordReset(values.email);
      // Always show the same confirmation, whether or not the address exists.
      // Revealing which emails are registered would leak account information.
      setSent(true);
    } catch (error) {
      setFormError(toAppError(error).message);
    }
  }

  if (sent) {
    return (
      <AuthLayout title="Check your email" subtitle="Password reset requested.">
        <div className="flex flex-col items-center text-center">
          <MailCheck className="size-10 text-navy-600" aria-hidden="true" />
          <p className="mt-4 text-sm text-muted">
            If an account exists for that address, we sent a link to reset your password. The link
            expires shortly, so use it soon.
          </p>
          <Link to="/login" className="mt-6 w-full">
            <Button fullWidth>Back to sign in</Button>
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="We will email you a link to choose a new password."
      footer={
        <Link to="/login" className="font-medium text-navy-700 hover:underline">
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
        {formError && (
          <div role="alert" className="rounded-lg border border-coral-100 bg-coral-50 px-3 py-2 text-sm text-coral-700">
            {formError}
          </div>
        )}

        <Input
          label="Email"
          type="email"
          autoComplete="email"
          placeholder="you@business.com"
          error={errors.email?.message}
          {...register('email')}
        />

        <Button type="submit" fullWidth loading={isSubmitting}>
          {isSubmitting ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>
    </AuthLayout>
  );
}
