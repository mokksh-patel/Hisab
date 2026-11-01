/**
 * errors.ts — turning Supabase/Postgres errors into messages a shop owner can
 * act on. Raw database errors are never shown to the user.
 */

export class AppError extends Error {
  readonly code: string;
  readonly details?: string;

  constructor(message: string, code = 'app_error', details?: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

interface PostgrestLikeError {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
}

/** Postgres SQLSTATE codes we translate explicitly. */
const SQLSTATE_MESSAGES: Record<string, string> = {
  '42501': 'You do not have permission to do that.',
  '23505': 'That record already exists.',
  '23503': 'This record is linked to other data and cannot be changed.',
  '23514': 'Some of the values entered are not valid.',
  '22023': 'Some of the values entered are not valid.',
  '28000': 'Please sign in again.',
  'P0002': 'That record could not be found.',
  '42P01': 'The database is not set up correctly. Please contact support.',
};

/**
 * Convert any thrown value into an AppError with a user-safe message.
 * Database constraint messages that we wrote ourselves (RAISE EXCEPTION with a
 * readable message) are passed through because they are already user-facing.
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  const candidate = error as PostgrestLikeError | null;
  const code = candidate?.code ?? 'unknown';
  const rawMessage = candidate?.message ?? (error instanceof Error ? error.message : String(error));

  // Our own RAISE EXCEPTION messages are written for humans.
  if (code === '22023' || code === 'P0002' || code === '42501') {
    if (rawMessage && !rawMessage.includes('violates') && !rawMessage.includes('duplicate key')) {
      return new AppError(rawMessage, code, candidate?.details);
    }
  }

  if (code === '23505') {
    if (rawMessage.includes('customers_business_phone_key')) {
      return new AppError('Another customer already uses this phone number.', code);
    }
    if (rawMessage.includes('invoices_business_number_key')) {
      return new AppError('That invoice number is already used. Choose a different number.', code);
    }
    if (rawMessage.includes('payments_business_idempotency_key')) {
      return new AppError('This payment was already recorded.', code);
    }
    return new AppError(SQLSTATE_MESSAGES['23505']!, code);
  }

  const mapped = SQLSTATE_MESSAGES[code];
  if (mapped) return new AppError(mapped, code, candidate?.details);

  // Auth errors carry a numeric status in `code` and a human-readable message.
  // Surface the ones a user can act on instead of a generic failure.
  const lower = rawMessage?.toLowerCase() ?? '';
  if (lower.includes('rate limit') || code === '429' || code === 'over_email_send_rate_limit') {
    return new AppError(
      'Too many attempts in a short time. Please wait a few minutes and try again.',
      'rate_limited',
    );
  }
  if (lower.includes('user already registered') || code === 'user_already_exists') {
    return new AppError('An account with this email already exists. Try signing in instead.', 'user_exists');
  }
  if (lower.includes('password should be at least') || code === 'weak_password') {
    return new AppError('Choose a stronger password (at least 8 characters).', 'weak_password');
  }
  if (lower.includes('signups not allowed') || code === 'signup_disabled') {
    return new AppError('New signups are currently disabled. Please contact support.', 'signup_disabled');
  }
  if (lower.includes('email address') && lower.includes('invalid')) {
    return new AppError('That email address was rejected. Use a real, deliverable address.', 'invalid_email');
  }

  if (lower.includes('failed to fetch')) {
    return new AppError('Could not reach the server. Check your internet connection and try again.', 'network');
  }

  return new AppError('Something went wrong. Please try again.', code, rawMessage);
}

/** Unwrap a Supabase `{ data, error }` result, throwing an AppError on failure. */
export function unwrap<T>(result: { data: T; error: PostgrestLikeError | null }): T {
  if (result.error) throw toAppError(result.error);
  return result.data;
}
