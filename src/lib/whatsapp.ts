/**
 * whatsapp.ts — click-to-open WhatsApp reminders.
 *
 * RULES:
 *  1. Phase 1 uses the official "Click to Chat" mechanism only
 *     (https://wa.me/<number>?text=<url-encoded message>). No unofficial
 *     automation, no bulk sending, no background messaging.
 *  2. The user always reviews and sends the message manually in WhatsApp.
 *     Opening the link is NOT proof that a reminder was sent — the app records
 *     a reminder only when the user explicitly confirms it.
 *  3. The message is fully URL-encoded, including ₹ and non-Latin characters.
 */

import { formatPaise, type Paise } from './money';
import { formatDate, type IsoDate } from './dateUtils';
import { toWhatsAppNumber } from './phone';

export interface ReminderContext {
  customerName: string;
  businessName: string;
  invoiceNumber: string;
  invoiceDate: IsoDate;
  dueDate: IsoDate;
  totalAmountPaise: Paise;
  outstandingPaise: Paise;
  daysOverdue: number;
}

export const DEFAULT_REMINDER_TEMPLATE = [
  'Dear {{customer_name}},',
  '',
  'This is a reminder that invoice {{invoice_number}} dated {{invoice_date}} is due for payment.',
  '',
  'Invoice amount: {{invoice_total}}',
  'Outstanding amount: {{outstanding_amount}}',
  'Due date: {{due_date}}',
  '',
  'Please let us know when we can expect the payment.',
  '',
  'Thank you,',
  '{{business_name}}',
].join('\n');

export const REMINDER_PLACEHOLDERS = [
  '{{customer_name}}',
  '{{business_name}}',
  '{{invoice_number}}',
  '{{invoice_date}}',
  '{{due_date}}',
  '{{invoice_total}}',
  '{{outstanding_amount}}',
  '{{days_overdue}}',
] as const;

/** Fill a reminder template with invoice values. Unknown placeholders are left intact. */
export function renderReminderTemplate(template: string, context: ReminderContext): string {
  const values: Record<string, string> = {
    '{{customer_name}}': context.customerName,
    '{{business_name}}': context.businessName,
    '{{invoice_number}}': context.invoiceNumber,
    '{{invoice_date}}': formatDate(context.invoiceDate),
    '{{due_date}}': formatDate(context.dueDate),
    '{{invoice_total}}': formatPaise(context.totalAmountPaise),
    '{{outstanding_amount}}': formatPaise(context.outstandingPaise),
    '{{days_overdue}}': String(Math.max(context.daysOverdue, 0)),
  };

  return template.replace(/\{\{[a-z_]+\}\}/g, (match) => values[match] ?? match);
}

/**
 * Build a `https://wa.me/...` link.
 * Returns null when the phone number is invalid so the UI can warn the user
 * instead of opening a broken chat.
 */
export function buildWhatsAppLink(phone: string | null | undefined, message: string): string | null {
  const number = toWhatsAppNumber(phone);
  if (!number) return null;
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}

/** Convenience: render the template and build the link in one step. */
export function buildReminderLink(
  phone: string | null | undefined,
  context: ReminderContext,
  template: string = DEFAULT_REMINDER_TEMPLATE,
): string | null {
  return buildWhatsAppLink(phone, renderReminderTemplate(template, context));
}
