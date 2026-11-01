import { describe, expect, it } from 'vitest';
import {
  PhoneError,
  formatPhone,
  isValidPhone,
  normalisePhone,
  toTelHref,
  toWhatsAppNumber,
  tryNormalisePhone,
} from '@/lib/phone';

describe('normalisePhone (acceptance test 10)', () => {
  it('normalises a bare 10-digit number', () => {
    expect(normalisePhone('9876543210')).toBe('+919876543210');
  });

  it('accepts common Indian formats', () => {
    expect(normalisePhone('+91 98765 43210')).toBe('+919876543210');
    expect(normalisePhone('09876543210')).toBe('+919876543210');
    expect(normalisePhone('0091-9876543210')).toBe('+919876543210');
    expect(normalisePhone('98765-43210')).toBe('+919876543210');
    expect(normalisePhone(' 9876543210 ')).toBe('+919876543210');
  });

  it('rejects invalid numbers', () => {
    expect(() => normalisePhone('12345')).toThrow(PhoneError);
    expect(() => normalisePhone('')).toThrow(PhoneError);
    expect(() => normalisePhone('abcdefghij')).toThrow(PhoneError);
    expect(() => normalisePhone('0123456789')).toThrow(PhoneError);
    expect(() => normalisePhone('98765432101')).toThrow(PhoneError);
  });

  it('exposes non-throwing helpers', () => {
    expect(tryNormalisePhone('12345')).toBeNull();
    expect(isValidPhone('9876543210')).toBe(true);
    expect(isValidPhone('12345')).toBe(false);
  });
});

describe('WhatsApp and display helpers', () => {
  it('produces digits-only international numbers', () => {
    expect(toWhatsAppNumber('+91 98765 43210')).toBe('919876543210');
    expect(toWhatsAppNumber('12345')).toBeNull();
    expect(toWhatsAppNumber(null)).toBeNull();
  });

  it('formats for display', () => {
    expect(formatPhone('+919876543210')).toBe('+91 98765 43210');
    expect(formatPhone(null)).toBe('—');
  });

  it('builds tel hrefs', () => {
    expect(toTelHref('9876543210')).toBe('+919876543210');
    expect(toTelHref('bad')).toBeNull();
  });
});
