import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REMINDER_TEMPLATE,
  buildReminderLink,
  buildWhatsAppLink,
  renderReminderTemplate,
  type ReminderContext,
} from '@/lib/whatsapp';

const context: ReminderContext = {
  customerName: 'Shah Textiles',
  businessName: 'Krutarth Traders',
  invoiceNumber: 'INV-2026-001',
  invoiceDate: '2026-10-01',
  dueDate: '2026-11-10',
  totalAmountPaise: 2_500_000n,
  outstandingPaise: 1_500_000n,
  daysOverdue: 12,
};

describe('renderReminderTemplate', () => {
  it('fills every placeholder', () => {
    const message = renderReminderTemplate(DEFAULT_REMINDER_TEMPLATE, context);
    expect(message).toContain('Dear Shah Textiles,');
    expect(message).toContain('INV-2026-001');
    expect(message).toContain('1 Oct 2026');
    expect(message).toContain('10 Nov 2026');
    expect(message).toContain('₹25,000.00');
    expect(message).toContain('₹15,000.00');
    expect(message).toContain('Krutarth Traders');
    expect(message).not.toContain('{{');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(renderReminderTemplate('Hi {{customer_name}} {{unknown}}', context)).toBe(
      'Hi Shah Textiles {{unknown}}',
    );
  });
});

describe('buildWhatsAppLink (acceptance test 11)', () => {
  it('builds a wa.me link with an encoded message', () => {
    const link = buildWhatsAppLink('9876543210', 'Amount due: ₹15,000');
    expect(link).not.toBeNull();
    expect(link!.startsWith('https://wa.me/919876543210?text=')).toBe(true);
    const encoded = link!.split('?text=')[1]!;
    expect(encoded).not.toContain(' ');
    expect(decodeURIComponent(encoded)).toBe('Amount due: ₹15,000');
  });

  it('encodes non-Latin characters correctly', () => {
    const link = buildWhatsAppLink('9876543210', 'કૃપા કરીને ચુકવણી કરો');
    const encoded = link!.split('?text=')[1]!;
    expect(decodeURIComponent(encoded)).toBe('કૃપા કરીને ચુકવણી કરો');
    expect(encoded).toMatch(/^%[0-9A-F]{2}/);
  });

  it('returns null for an invalid phone number', () => {
    expect(buildWhatsAppLink('12345', 'hello')).toBeNull();
    expect(buildWhatsAppLink(null, 'hello')).toBeNull();
  });

  it('builds a full reminder link end to end', () => {
    const link = buildReminderLink('+91 98765 43210', context);
    expect(link).toContain('https://wa.me/919876543210?text=');
    const message = decodeURIComponent(link!.split('?text=')[1]!);
    expect(message).toContain('Outstanding amount: ₹15,000.00');
  });
});
