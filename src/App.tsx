/**
 * App.tsx — routing and top-level guards.
 *
 * Route protection is layered:
 *   1. `RequireAuth`  — no session means redirect to /login.
 *   2. `RequireBusiness` — a session with no business lands on onboarding.
 *
 * These guards are a usability layer only. The real security boundary is
 * Postgres RLS, which rejects cross-tenant reads and writes regardless of what
 * the browser renders.
 */

import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { useBusiness } from '@/context/BusinessContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { FullPageLoader } from '@/components/layout/FullPageLoader';
import { ConfigErrorScreen } from '@/pages/ConfigErrorScreen';

// Auth screens are small and needed immediately.
import { LoginPage } from '@/pages/auth/LoginPage';
import { SignUpPage } from '@/pages/auth/SignUpPage';
import { ForgotPasswordPage } from '@/pages/auth/ForgotPasswordPage';
import { ResetPasswordPage } from '@/pages/auth/ResetPasswordPage';
import { AuthCallbackPage } from '@/pages/auth/AuthCallbackPage';
import { OnboardingPage } from '@/pages/onboarding/OnboardingPage';

// Heavier authenticated screens are code-split.
const DashboardPage = lazy(() => import('@/pages/dashboard/DashboardPage'));
const InvoicesPage = lazy(() => import('@/pages/invoices/InvoicesPage'));
const InvoiceDetailPage = lazy(() => import('@/pages/invoices/InvoiceDetailPage'));
const CreateInvoicePage = lazy(() => import('@/pages/invoices/CreateInvoicePage'));
const CustomersPage = lazy(() => import('@/pages/customers/CustomersPage'));
const CustomerDetailPage = lazy(() => import('@/pages/customers/CustomerDetailPage'));
const PaymentsPage = lazy(() => import('@/pages/payments/PaymentsPage'));
const ReportsPage = lazy(() => import('@/pages/reports/ReportsPage'));
const SettingsPage = lazy(() => import('@/pages/settings/SettingsPage'));
const NotFoundPage = lazy(() => import('@/pages/NotFoundPage'));

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageLoader label="Checking your session" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

function RequireBusiness({ children }: { children: React.ReactNode }) {
  const { currentBusiness, loading } = useBusiness();

  if (loading) return <FullPageLoader label="Loading your business" />;
  if (!currentBusiness) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}

function RedirectIfAuthed({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <FullPageLoader label="Checking your session" />;
  if (user) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  const { misconfigured } = useAuth();

  if (misconfigured) return <ConfigErrorScreen />;

  return (
    <Suspense fallback={<FullPageLoader label="Loading" />}>
      <Routes>
        {/* Public */}
        <Route
          path="/login"
          element={
            <RedirectIfAuthed>
              <LoginPage />
            </RedirectIfAuthed>
          }
        />
        <Route
          path="/signup"
          element={
            <RedirectIfAuthed>
              <SignUpPage />
            </RedirectIfAuthed>
          }
        />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/auth/callback" element={<AuthCallbackPage />} />
        <Route path="/auth/reset-password" element={<ResetPasswordPage />} />

        {/* Onboarding: authenticated but may have no business yet */}
        <Route
          path="/onboarding"
          element={
            <RequireAuth>
              <OnboardingPage />
            </RequireAuth>
          }
        />

        {/* Authenticated application */}
        <Route
          element={
            <RequireAuth>
              <RequireBusiness>
                <AppLayout />
              </RequireBusiness>
            </RequireAuth>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="invoices" element={<InvoicesPage />} />
          <Route path="invoices/new" element={<CreateInvoicePage />} />
          <Route path="invoices/:invoiceId" element={<InvoiceDetailPage />} />
          <Route path="customers" element={<CustomersPage />} />
          <Route path="customers/:customerId" element={<CustomerDetailPage />} />
          <Route path="payments" element={<PaymentsPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}
