import { describe, expect, it } from 'vitest';
import {
  addDays,
  daysBetween,
  daysPastDue,
  describeDueDate,
  financialYearOf,
  financialYearRange,
  formatDate,
  isIsoDate,
  isOverdue,
  startOfMonth,
  startOfWeek,
  todayInTimeZone,
} from '@/lib/dateUtils';

describe('todayInTimeZone', () => {
  it('resolves the calendar date in Asia/Kolkata, not UTC', () => {
    // 2026-10-11T19:00:00Z is 2026-10-12 00:30 IST — the next calendar day.
    const instant = new Date('2026-10-11T19:00:00Z');
    expect(todayInTimeZone('Asia/Kolkata', instant)).toBe('2026-10-12');
    expect(todayInTimeZone('UTC', instant)).toBe('2026-10-11');
  });

  it('handles the IST midnight boundary exactly', () => {
    expect(todayInTimeZone('Asia/Kolkata', new Date('2026-10-11T18:29:59Z'))).toBe('2026-10-11');
    expect(todayInTimeZone('Asia/Kolkata', new Date('2026-10-11T18:30:00Z'))).toBe('2026-10-12');
  });
});

describe('addDays / daysBetween', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29'); // leap year
  });

  it('counts whole days', () => {
    expect(daysBetween('2026-10-01', '2026-10-11')).toBe(10);
    expect(daysBetween('2026-10-11', '2026-10-01')).toBe(-10);
    expect(daysBetween('2026-10-11', '2026-10-11')).toBe(0);
  });

  it('rejects non-integer offsets', () => {
    expect(() => addDays('2026-10-11', 1.5)).toThrow();
  });
});

describe('overdue rules', () => {
  it('an invoice due today is not overdue', () => {
    expect(daysPastDue('2026-10-11', '2026-10-11')).toBe(0);
    expect(isOverdue('2026-10-11', '2026-10-11')).toBe(false);
  });

  it('an invoice due yesterday is 1 day overdue', () => {
    expect(daysPastDue('2026-10-10', '2026-10-11')).toBe(1);
    expect(isOverdue('2026-10-10', '2026-10-11')).toBe(true);
  });

  it('a future due date is not overdue', () => {
    expect(daysPastDue('2026-10-20', '2026-10-11')).toBe(-9);
    expect(isOverdue('2026-10-20', '2026-10-11')).toBe(false);
  });

  it('describes due dates in plain language', () => {
    expect(describeDueDate('2026-10-11', '2026-10-11')).toBe('Due today');
    expect(describeDueDate('2026-10-12', '2026-10-11')).toBe('Due tomorrow');
    expect(describeDueDate('2026-10-20', '2026-10-11')).toBe('Due in 9 days');
    expect(describeDueDate('2026-10-10', '2026-10-11')).toBe('1 day overdue');
    expect(describeDueDate('2026-09-11', '2026-10-11')).toBe('30 days overdue');
  });
});

describe('financial year', () => {
  it('starts on 1 April', () => {
    expect(financialYearOf('2026-03-31')).toBe('2025-26');
    expect(financialYearOf('2026-04-01')).toBe('2026-27');
    expect(financialYearOf('2026-10-11')).toBe('2026-27');
    expect(financialYearOf('2027-03-31')).toBe('2026-27');
  });

  it('computes the range for a label', () => {
    expect(financialYearRange('2026-27')).toEqual({ start: '2026-04-01', end: '2027-03-31' });
  });

  it('rejects malformed labels', () => {
    expect(() => financialYearRange('2026')).toThrow();
  });
});

describe('date validation and formatting', () => {
  it('validates ISO dates', () => {
    expect(isIsoDate('2026-10-11')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('11-10-2026')).toBe(false);
    expect(isIsoDate('2026-1-1')).toBe(false);
  });

  it('formats as "12 Oct 2026"', () => {
    expect(formatDate('2026-10-12')).toBe('12 Oct 2026');
    expect(formatDate(null)).toBe('—');
  });

  it('computes month and week starts', () => {
    expect(startOfMonth('2026-10-11')).toBe('2026-10-01');
    expect(startOfWeek('2026-10-11')).toBe('2026-10-05'); // Sunday -> Monday
    expect(startOfWeek('2026-10-12')).toBe('2026-10-12'); // Monday
  });
});
