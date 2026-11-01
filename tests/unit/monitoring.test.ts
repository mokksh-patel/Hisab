/**
 * monitoring.test.ts — proves the error reporter never leaks sensitive data.
 *
 * This is the security-critical part of monitoring: a log that contains a
 * password or token is a breach.
 */

import { describe, expect, it } from 'vitest';
import { sanitiseMeta, sanitiseText } from '@/lib/monitoring';

describe('sanitiseText', () => {
  it('redacts JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
    expect(sanitiseText(`token was ${jwt}`)).toBe('token was [jwt]');
  });

  it('redacts Supabase secret keys', () => {
    expect(sanitiseText('key sb_secret_Zq7xK2mN9pL4wR8tY6vB3cD5fG1hJ0kM')).toBe(
      'key [secret-key]',
    );
  });

  it('redacts publishable keys', () => {
    expect(sanitiseText('sb_publishable_snxUneMLSFmu0Vuwgt3REQ_S2XKWsBD')).toBe(
      '[publishable-key]',
    );
  });

  it('redacts connection strings', () => {
    expect(sanitiseText('postgresql://user:pass@host:5432/db')).toBe('[connection-string]');
  });

  it('redacts email addresses', () => {
    expect(sanitiseText('failed for owner@business.com')).toBe('failed for [email]');
  });

  it('redacts long digit sequences (card/account numbers)', () => {
    expect(sanitiseText('card 4111111111111111 declined')).toBe('card [long-number] declined');
  });

  it('leaves ordinary messages untouched', () => {
    expect(sanitiseText('Invoice not found in this business')).toBe(
      'Invoice not found in this business',
    );
  });
});

describe('sanitiseMeta', () => {
  it('redacts sensitive keys regardless of case', () => {
    const clean = sanitiseMeta({
      Password: 'hunter2',
      access_token: 'abc',
      idempotency_key: 'key-123',
      customerName: 'Acme',
    });
    expect(clean).toEqual({
      Password: '[redacted]',
      access_token: '[redacted]',
      idempotency_key: '[redacted]',
      customerName: 'Acme',
    });
  });

  it('scrubs string values inside nested objects', () => {
    const clean = sanitiseMeta({
      request: { body: 'email owner@business.com' },
    });
    expect(clean).toEqual({ request: { body: 'email [email]' } });
  });

  it('returns undefined for undefined input', () => {
    expect(sanitiseMeta(undefined)).toBeUndefined();
  });

  it('preserves non-sensitive numbers and booleans', () => {
    const clean = sanitiseMeta({ amountPaise: 590000, reversed: false });
    expect(clean).toEqual({ amountPaise: 590000, reversed: false });
  });
});
