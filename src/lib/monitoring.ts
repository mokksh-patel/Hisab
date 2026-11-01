/**
 * monitoring.ts — error capture and sanitisation.
 *
 * DESIGN RULES
 *  1. Never log passwords, tokens, payment details or full personal data.
 *  2. Errors are captured in one place so a real provider (Sentry, Rollbar) can
 *     be attached later without touching call sites.
 *  3. Reporting must never throw — a monitoring failure must not break the app.
 *
 * Today this writes to the console and keeps a bounded in-memory ring buffer.
 * To enable remote reporting, set VITE_ERROR_ENDPOINT and implement `send()`.
 */

export type ErrorSeverity = 'error' | 'warning' | 'info';

export interface ErrorReport {
  message: string;
  severity: ErrorSeverity;
  /** Where it happened, e.g. "invoiceService.listInvoices". */
  context?: string;
  /** Sanitised, non-sensitive extras. */
  meta?: Record<string, unknown>;
  timestamp: string;
  url?: string;
  userAgent?: string;
}

const MAX_BUFFER = 50;
const buffer: ErrorReport[] = [];

/** Keys whose values must never leave the browser. */
const REDACTED_KEYS = [
  'password',
  'passwd',
  'token',
  'access_token',
  'refresh_token',
  'authorization',
  'apikey',
  'api_key',
  'secret',
  'card',
  'cvv',
  'pan',
  'account_number',
  'idempotency_key',
];

/** Patterns scrubbed from free-text messages. */
const REDACTION_PATTERNS: [RegExp, string][] = [
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[jwt]'],
  [/sb_secret_[A-Za-z0-9_-]+/g, '[secret-key]'],
  [/sb_publishable_[A-Za-z0-9_-]+/g, '[publishable-key]'],
  [/postgres(ql)?:\/\/[^\s]+/g, '[connection-string]'],
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]'],
  [/\b\d{12,19}\b/g, '[long-number]'],
];

/** Remove sensitive values from a string. */
export function sanitiseText(input: string): string {
  let output = input;
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

/** Recursively strip sensitive keys and scrub string values. */
export function sanitiseMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined;

  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (REDACTED_KEYS.some((redacted) => key.toLowerCase().includes(redacted))) {
      clean[key] = '[redacted]';
      continue;
    }
    if (typeof value === 'string') {
      clean[key] = sanitiseText(value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      clean[key] = sanitiseMeta(value as Record<string, unknown>);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

function send(report: ErrorReport): void {
  const endpoint = import.meta.env.VITE_ERROR_ENDPOINT;
  if (!endpoint) return;

  // Fire-and-forget. Never await, never throw.
  try {
    void fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
      keepalive: true,
    }).catch(() => {
      /* monitoring must never break the app */
    });
  } catch {
    /* ignore */
  }
}

/** Record an error. Safe to call from anywhere. */
export function reportError(
  error: unknown,
  options: { context?: string; severity?: ErrorSeverity; meta?: Record<string, unknown> } = {},
): void {
  const { context, severity = 'error', meta } = options;

  const rawMessage =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';

  const report: ErrorReport = {
    message: sanitiseText(rawMessage),
    severity,
    context,
    meta: sanitiseMeta(meta),
    timestamp: new Date().toISOString(),
    url: typeof window !== 'undefined' ? sanitiseText(window.location.pathname) : undefined,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
  };

  buffer.push(report);
  if (buffer.length > MAX_BUFFER) buffer.shift();

  if (severity === 'error') {
    console.error(`[${context ?? 'app'}]`, report.message, report.meta ?? '');
  } else if (severity === 'warning') {
    console.warn(`[${context ?? 'app'}]`, report.message);
  }

  send(report);
}

/** Recent reports, for a diagnostics screen or support request. */
export function getRecentErrors(): readonly ErrorReport[] {
  return buffer;
}

/** Install global handlers for uncaught errors and unhandled rejections. */
export function installGlobalErrorHandlers(): void {
  if (typeof window === 'undefined') return;

  window.addEventListener('error', (event) => {
    reportError(event.error ?? event.message, { context: 'window.onerror' });
  });

  window.addEventListener('unhandledrejection', (event) => {
    reportError(event.reason, { context: 'unhandledrejection' });
  });
}
