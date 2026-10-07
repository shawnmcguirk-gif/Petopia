// Dates and amounts the way a person says them (Irish English). A vague date stays vague: "2025", "Oct 2025".
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function niceDate(d: string | null | undefined): string {
  if (!d) return '';
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(d);
  if (!m) return d;
  if (!m[2]) return m[1]!;
  if (!m[3]) return `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** Today's date in Ireland (Europe/Dublin), whatever the time zone of the machine running this: the household's day
 *  turns over at midnight in Dublin, not at midnight on the server or the phone (independent review, finding 7). */
const DUBLIN_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit' });
export function todayIso(d = new Date()): string {
  const p = Object.fromEntries(DUBLIN_DAY.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** "+0.2 kg" / "−0.1 kg" / "no change", or null when there is nothing to compare with. */
export function changeText(change: string | null | undefined, unit: string): string | null {
  if (change === null || change === undefined) return null;
  if (Number(change) === 0) return 'no change';
  return `${change.startsWith('-') ? '−' : '+'}${String(Math.abs(Number(change)))} ${unit}`;
}

export const num = (s: string | null | undefined): string => (s === null || s === undefined ? '' : String(Number(s)));
