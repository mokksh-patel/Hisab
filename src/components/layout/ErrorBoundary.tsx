import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { reportError } from '@/lib/monitoring';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * ErrorBoundary — catches render-time errors so a single broken component does
 * not blank the whole application.
 *
 * The error is reported through the monitoring layer (sanitised) and the user
 * gets a recovery path rather than a white screen.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportError(error, {
      context: 'react.errorBoundary',
      meta: { componentStack: info.componentStack?.slice(0, 500) },
    });
  }

  private handleReload = (): void => {
    window.location.assign('/');
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center bg-page px-4">
        <div className="w-full max-w-md rounded-xl border border-line bg-surface p-6 text-center">
          <AlertTriangle className="mx-auto size-8 text-warning-600" aria-hidden="true" />
          <h1 className="mt-3 text-lg font-semibold text-ink">Something went wrong</h1>
          <p className="mt-2 text-sm text-muted">
            The page could not be displayed. Your data has not been changed.
          </p>
          <button
            type="button"
            onClick={this.handleReload}
            className="mt-5 h-11 w-full rounded-lg bg-navy-700 text-sm font-medium text-white hover:bg-navy-800"
          >
            Back to dashboard
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-2 h-11 w-full rounded-lg border border-line bg-white text-sm font-medium text-ink hover:bg-slate-50"
          >
            Reload the page
          </button>
        </div>
      </div>
    );
  }
}
