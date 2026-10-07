// Age is never stored (spec sec 3.3): it is computed from born_on + born_precision and shown with its precision.
// Banoffee, born_on 2018-01-01 / YEAR, in 2026 -> "about 8 years". Pure; `today` is passed in so tests are fixed.
export const PRECISIONS = ['DAY', 'MONTH', 'YEAR', 'UNKNOWN'] as const;
export type Precision = (typeof PRECISIONS)[number];

export interface Age {
  years: number;
  months: number; // whole months beyond `years` (0 when precision is YEAR)
  text: string;
  approximate: boolean;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const parts = (iso: string): [number, number, number] | null => {
  const m = ISO.exec(iso);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function todayIso(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** null when the date is unknown, unreadable, or in the future. */
export function ageOf(bornOn: string | null, precision: Precision, today: string = todayIso()): Age | null {
  if (!bornOn || precision === 'UNKNOWN') return null;
  const b = parts(bornOn);
  const t = parts(today);
  if (!b || !t) return null;
  const [by, bm, bd] = b;
  const [ty, tm, td] = t;
  if (precision === 'YEAR') {
    // Only the year is known: the honest answer is the difference in calendar years, said as "about".
    const years = ty - by;
    if (years < 0) return null;
    return { years, months: 0, approximate: true, text: years === 0 ? 'under a year' : `about ${plural(years, 'year')}` };
  }
  let months = (ty - by) * 12 + (tm - bm);
  if (precision === 'DAY' && td < bd) months -= 1; // not yet reached this month's birthday
  if (months < 0) return null;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  const approximate = precision === 'MONTH';
  const pre = approximate ? 'about ' : '';
  let text: string;
  if (years >= 2) text = `${pre}${plural(years, 'year')}`;
  else if (years === 1) text = rest ? `${pre}1 year ${plural(rest, 'month')}` : `${pre}1 year`;
  else if (months >= 1) text = `${pre}${plural(months, 'month')}`;
  else if (precision === 'DAY') {
    const days = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(by, bm - 1, bd)) / 86_400_000);
    text = days >= 7 ? plural(Math.floor(days / 7), 'week') : plural(days, 'day');
  } else text = 'under a month';
  return { years, months: rest, approximate, text };
}

/**
 * A vague date as a person types it: "2018" (YEAR), "2018-03" (MONTH) or "2018-03-14" (DAY). Stored as the first day
 * of the period plus its precision, so "2018" becomes 2018-01-01 / YEAR. Returns null for anything else.
 */
export function parseVagueDate(input: unknown): { on: string; precision: Exclude<Precision, 'UNKNOWN'> } | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  let m = /^(\d{4})$/.exec(s);
  if (m) return validYear(m[1]!) ? { on: `${m[1]}-01-01`, precision: 'YEAR' } : null;
  m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (m) {
    const mo = Number(m[2]);
    return validYear(m[1]!) && mo >= 1 && mo <= 12 ? { on: `${m[1]}-${String(mo).padStart(2, '0')}-01`, precision: 'MONTH' } : null;
  }
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (!validYear(m[1]!) || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return { on: `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, precision: 'DAY' };
  }
  return null;
}
const validYear = (y: string): boolean => Number(y) >= 1900 && Number(y) <= 2200;

/** The stored pair back as the person typed it: 2018-01-01/YEAR -> "2018". */
export function formatVagueDate(on: string | null, precision: Precision): string | null {
  if (!on || precision === 'UNKNOWN') return null;
  if (precision === 'YEAR') return on.slice(0, 4);
  if (precision === 'MONTH') return on.slice(0, 7);
  return on;
}
