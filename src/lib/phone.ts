/**
 * phone.ts — Indian phone number normalisation for WhatsApp reminders.
 *
 * RULES:
 *  1. Store phone numbers in E.164 form: "+919876543210".
 *  2. Accept common Indian input styles: "9876543210", "09876543210",
 *     "+91 98765 43210", "0091-9876543210", "98765-43210".
 *  3. Reject anything that is not a valid Indian mobile or landline number.
 *  4. WhatsApp links require digits only, with country code, no "+" or spaces.
 */

export class PhoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhoneError';
  }
}

const INDIA_COUNTRY_CODE = '91';

/** Strip every non-digit character. */
function digitsOnly(input: string): string {
  return input.replace(/\D/g, '');
}

/**
 * Normalise an Indian phone number to E.164 ("+91XXXXXXXXXX").
 * @throws PhoneError when the number is not a valid Indian number.
 */
export function normalisePhone(input: string): string {
  const raw = input.trim();
  if (raw === '') throw new PhoneError('Phone number is required');

  let digits = digitsOnly(raw);

  // Strip international prefixes.
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 12 && digits.startsWith(INDIA_COUNTRY_CODE)) {
    digits = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  if (digits.length !== 10) {
    throw new PhoneError('Enter a 10-digit Indian phone number');
  }
  // Indian mobile numbers start with 6–9; landlines start with 1–5 and are
  // accepted because many small businesses still use them.
  if (!/^[1-9]\d{9}$/.test(digits)) {
    throw new PhoneError('Enter a valid Indian phone number');
  }

  return `+${INDIA_COUNTRY_CODE}${digits}`;
}

/** Non-throwing variant: returns null when the number is invalid. */
export function tryNormalisePhone(input: string): string | null {
  try {
    return normalisePhone(input);
  } catch {
    return null;
  }
}

export function isValidPhone(input: string): boolean {
  return tryNormalisePhone(input) !== null;
}

/**
 * Digits-only international form for `wa.me` links: "+919876543210" -> "919876543210".
 * Returns null when the stored value is not a valid number.
 */
export function toWhatsAppNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const normalised = tryNormalisePhone(phone);
  return normalised ? normalised.replace('+', '') : null;
}

/** Display form for tables: "+91 98765 43210". */
export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return '—';
  const normalised = tryNormalisePhone(phone);
  if (!normalised) return phone;
  const digits = normalised.slice(3);
  return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
}

/** `tel:` href for click-to-call. */
export function toTelHref(phone: string | null | undefined): string | null {
  const normalised = phone ? tryNormalisePhone(phone) : null;
  return normalised ?? null;
}
