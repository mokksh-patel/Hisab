import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ToastProvider } from '@/components/ui/Toast';
import { AuthProvider } from '@/context/AuthContext';
import { BusinessProvider } from '@/context/BusinessContext';
import { ErrorBoundary } from '@/components/layout/ErrorBoundary';
import { installGlobalErrorHandlers, reportError } from '@/lib/monitoring';
import './styles/index.css';

// Capture uncaught errors and unhandled promise rejections before React mounts.
installGlobalErrorHandlers();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Financial data must not go stale silently. A short stale window keeps
      // navigation snappy without showing yesterday's balance.
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
    mutations: {
      onError: (error) => {
        // Mutations are financial writes; every failure is worth recording.
        reportError(error, { context: 'mutation' });
      },
    },
  },
});

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element #root not found in index.html');

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ToastProvider>
            <AuthProvider>
              <BusinessProvider>
                <App />
              </BusinessProvider>
            </AuthProvider>
          </ToastProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
