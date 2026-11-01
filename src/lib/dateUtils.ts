/**
 * dateUtils.ts — date handling for BizPilot.
 *
 * RULES:
 *  1. Business dates (invoice date, due date, payment date) are calendar dates
 *     with no time component. They are represented as `YYYY-MM-DD` strings and
 *     stored in Postgres as `date`.
 *  2. "Today" is always resolved in the business time zone (default
 *     Asia/Kolkata), never in the browser's local zone or UTC.
 *  3. Day arithmetic is done on UTC midnights so DST and time zones can never
 *     shift a calendar day.
 */

export const DEFAULT_TIME_ZONE = 'Asia/Kolkata';

/** A calendar date in `YYYY-MM-DD` form. */
export type IsoDate = string;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class DateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DateError';
  }
}

/** Validate and normalise a `YYYY-MM-DD` string. */
export function assertIsoDate(value: string): IsoDate {
  if (!ISO_DATE_RE.test(value)) {
    throw new DateError(`Expected a YYYY-MM-DD date, received "${value}"`);
  }
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  ) {
    throw new DateError(`"${value}" is not a real calendar date`);
  }
  return value;
}

export function isIsoDate(value: string): boolean {
  try {
    assertIsoDate(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Current calendar date in the given time zone.
 * Uses `Intl.DateTimeFormat` with `en-CA`, which formats as YYYY-MM-DD.
 */
export function todayInTimeZone(timeZone: string = DEFAULT_TIME_ZONE, now: Date = new Date()): IsoDate {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(now);
}

/** Convert an ISO date to a UTC-midnight Date for arithmetic. */
function toUtcMidnight(date: IsoDate): Date {
  const [y, m, d] = assertIsoDate(date).split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtcMidnight(date: Date): IsoDate {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Add (or subtract, with a negative count) whole days to a calendar date. */
export function addDays(date: IsoDate, days: number): IsoDate {
  if (!Number.isInteger(days)) throw new DateError('Day offset must be an integer');
  const base = toUtcMidnight(date);
  base.setUTCDate(base.getUTCDate() + days);
  return fromUtcMidnight(base);
}

/**
 * Whole calendar days from `from` to `to` (to - from).
 * `daysBetween('2026-10-01', '2026-10-11')` -> 10.
 */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const ms = toUtcMidnight(to).getTime() - toUtcMidnight(from).getTime();
  return Math.round(ms / 86_400_000);
}

/**
 * Days past due for an invoice.
 *  - Negative when the due date is in the future (not yet due).
 *  - 0 when the due date is today (due today, NOT overdue).
 *  - Positive when overdue.
 */
export function daysPastDue(dueDate: IsoDate, asOf: IsoDate): number {
  return daysBetween(dueDate, asOf);
}

/** True only when the due date is strictly before the as-of date. */
export function isOverdue(dueDate: IsoDate, asOf: IsoDate): boolean {
  return daysPastDue(dueDate, asOf) > 0;
}

/** Indian financial year label for a date, e.g. 2026-04-01 -> "2026-27". */
export function financialYearOf(date: IsoDate, startMonth = 4): string {
  const [y, m] = assertIsoDate(date).split('-').map(Number) as [number, number, number];
  const startYear = m >= startMonth ? y : y - 1;
  const endYear = (startYear + 1) % 100;
  return `${startYear}-${String(endYear).padStart(2, '0')}`;
}

/** First and last calendar date of a financial year label ("2026-27"). */
export function financialYearRange(label: string, startMonth = 4): { start: IsoDate; end: IsoDate } {
  const match = /^(\d{4})-(\d{2})$/.exec(label);
  if (!match) throw new DateError(`Invalid financial year label "${label}"`);
  const startYear = Number(match[1]);
  const start = `${startYear}-${String(startMonth).padStart(2, '0')}-01`;
  const end = addDays(`${startYear + 1}-${String(startMonth).padStart(2, '0')}-01`, -1);
  return { start, end };
}

/** Start of the month containing `date`. */
export function startOfMonth(date: IsoDate): IsoDate {
  const [y, m] = assertIsoDate(date).split('-').map(Number) as [number, number, number];
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

/** Start of the week (Monday) containing `date`. */
export function startOfWeek(date: IsoDate): IsoDate {
  const probe = toUtcMidnight(date);
  const weekday = probe.getUTCDay(); // 0 = Sunday
  const offset = weekday === 0 ? 6 : weekday - 1;
  return addDays(date, -offset);
}

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/** Display format used across the app: "12 Oct 2026". */
export function formatDate(date: IsoDate | null | undefined): string {
  if (!date) return '—';
  const [y, m, d] = assertIsoDate(date).split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS_SHORT[m - 1]} ${y}`;
}

/** Short display format: "12 Oct". */
export function formatDateShort(date: IsoDate | null | undefined): string {
  if (!date) return '—';
  const [, m, d] = assertIsoDate(date).split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS_SHORT[m - 1]}`;
}

/** Human relative label for a due date, e.g. "Due today", "12 days overdue". */
export function describeDueDate(dueDate: IsoDate, asOf: IsoDate): string {
  const diff = daysPastDue(dueDate, asOf);
  if (diff === 0) return 'Due today';
  if (diff < 0) {
    const inDays = -diff;
    return inDays === 1 ? 'Due tomorrow' : `Due in ${inDays} days`;
  }
  return diff === 1 ? '1 day overdue' : `${diff} days overdue`;
}

/** Convert a JS Date to an ISO calendar date in the given time zone. */
export function toIsoDateInTimeZone(date: Date, timeZone: string = DEFAULT_TIME_ZONE): IsoDate {
  return todayInTimeZone(timeZone, date);
}
