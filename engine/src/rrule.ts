// The routine schedule (spec sec 3.5 care.routine `rrule`): a small, explicit subset of RFC 5545, enough for pet care --
//   FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, optional INTERVAL=n, optional BYDAY=MO,TU,... (WEEKLY only).
// Anchored at the routine's active_from date. MONTHLY / YEARLY keep the anchor's day, clamped to the month's last day
// (31 Jan -> 28/29 Feb). Pure, date-only (YYYY-MM-DD, no time zones): times of day are separate (care.routine.times).
export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
export interface Rule { freq: Freq; interval: number; byday: number[] | null } // byday: 0 = Monday ... 6 = Sunday
const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
export const RRULE_RE = /^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;INTERVAL=[1-9][0-9]{0,2})?(;BYDAY=(MO|TU|WE|TH|FR|SA|SU)(,(MO|TU|WE|TH|FR|SA|SU)){0,6})?$/;

export function parseRule(s: string): Rule | null {
  if (!RRULE_RE.test(s)) return null;
  const parts = Object.fromEntries(s.split(';').map((p) => p.split('=') as [string, string]));
  const freq = parts.FREQ as Freq;
  if (parts.BYDAY && freq !== 'WEEKLY') return null;
  return { freq, interval: parts.INTERVAL ? Number(parts.INTERVAL) : 1, byday: parts.BYDAY ? [...new Set(parts.BYDAY.split(',').map((d) => DAYS.indexOf(d)))].sort() : null };
}

const ms = (d: string): number => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
export const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);
export const addDays = (d: string, n: number): string => iso(ms(d) + n * 86_400_000);
export const daysBetween = (a: string, b: string): number => Math.round((ms(b) - ms(a)) / 86_400_000);
const weekday = (d: string): number => (new Date(ms(d)).getUTCDay() + 6) % 7; // Monday 0
const lastDay = (y: number, m: number): number => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
function monthsFrom(anchor: string, months: number): string {
  const y = Number(anchor.slice(0, 4));
  const m = Number(anchor.slice(5, 7)) - 1 + months;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  const dd = Math.min(Number(anchor.slice(8, 10)), lastDay(yy, mm));
  return iso(Date.UTC(yy, mm, dd));
}

/** Is `day` an occurrence of the rule anchored at `anchor`? */
export function occursOn(r: Rule, anchor: string, day: string): boolean {
  if (day < anchor) return false;
  const n = daysBetween(anchor, day);
  switch (r.freq) {
    case 'DAILY': return n % r.interval === 0;
    case 'WEEKLY': {
      const days = r.byday ?? [weekday(anchor)];
      if (!days.includes(weekday(day))) return false;
      const weekStart = (d: string) => addDays(d, -weekday(d));
      const weeks = daysBetween(weekStart(anchor), weekStart(day)) / 7;
      return weeks % r.interval === 0;
    }
    case 'MONTHLY': case 'YEARLY': {
      const step = r.freq === 'MONTHLY' ? r.interval : 12 * r.interval;
      const months = (Number(day.slice(0, 4)) - Number(anchor.slice(0, 4))) * 12 + Number(day.slice(5, 7)) - Number(anchor.slice(5, 7));
      return months >= 0 && months % step === 0 && monthsFrom(anchor, months) === day;
    }
  }
}

/** Occurrences in [from, to] (inclusive), at most `max`. */
export function occurrences(r: Rule, anchor: string, from: string, to: string, max = 400): string[] {
  const out: string[] = [];
  if (r.freq === 'MONTHLY' || r.freq === 'YEARLY') {
    const step = r.freq === 'MONTHLY' ? r.interval : 12 * r.interval;
    for (let k = 0; out.length < max; k += step) {
      const d = monthsFrom(anchor, k);
      if (d > to) break;
      if (d >= from) out.push(d);
    }
    return out;
  }
  for (let d = from < anchor ? anchor : from; d <= to && out.length < max; d = addDays(d, 1)) if (occursOn(r, anchor, d)) out.push(d);
  return out;
}

/** The latest occurrence on or before `day`, or null. */
export function lastOnOrBefore(r: Rule, anchor: string, day: string): string | null {
  if (day < anchor) return null;
  const span = r.freq === 'DAILY' ? r.interval : r.freq === 'WEEKLY' ? 7 * r.interval : r.freq === 'MONTHLY' ? 31 * r.interval : 366 * r.interval;
  const from = addDays(day, -span);
  const xs = occurrences(r, anchor, from < anchor ? anchor : from, day);
  return xs.length ? xs[xs.length - 1]! : null;
}

/** How many occurrences a day, on average (for medication supply). */
export const perDay = (r: Rule): number => {
  const per = r.freq === 'DAILY' ? 1 : r.freq === 'WEEKLY' ? (r.byday?.length ?? 1) / 7 : r.freq === 'MONTHLY' ? 12 / 365 : 1 / 365;
  return per / r.interval;
};
