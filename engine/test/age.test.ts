// Age is computed from born_on + precision, never stored (spec sec 3.3). Fixed `today` so these never drift.
import { describe, expect, it } from 'vitest';
import { ageOf, formatVagueDate, parseVagueDate } from '../src/age.js';

const T = '2026-10-07';

describe('ageOf', () => {
  it('YEAR precision is "about": born 2018 (stored 2018-01-01/YEAR) is about 8 years in 2026 (S1 acceptance)', () => {
    expect(ageOf('2018-01-01', 'YEAR', T)).toEqual({ years: 8, months: 0, approximate: true, text: 'about 8 years' });
  });
  it('YEAR precision does not pretend to know the birthday: same answer on 1 Jan and 31 Dec', () => {
    expect(ageOf('2018-01-01', 'YEAR', '2026-01-01')?.text).toBe('about 8 years');
    expect(ageOf('2018-01-01', 'YEAR', '2026-12-31')?.text).toBe('about 8 years');
  });
  it('YEAR precision: one year and this year', () => {
    expect(ageOf('2025-01-01', 'YEAR', T)?.text).toBe('about 1 year');
    expect(ageOf('2026-01-01', 'YEAR', T)?.text).toBe('under a year');
  });
  it('MONTH precision is "about" and counts whole months', () => {
    expect(ageOf('2018-03-01', 'MONTH', T)).toMatchObject({ years: 8, months: 7, approximate: true, text: 'about 8 years' });
    expect(ageOf('2025-06-01', 'MONTH', T)?.text).toBe('about 1 year 4 months');
    expect(ageOf('2026-04-01', 'MONTH', T)?.text).toBe('about 6 months');
    expect(ageOf('2026-10-01', 'MONTH', T)?.text).toBe('under a month');
  });
  it('DAY precision is exact and respects the birthday not yet reached', () => {
    expect(ageOf('2018-10-07', 'DAY', T)).toMatchObject({ years: 8, approximate: false, text: '8 years' });
    expect(ageOf('2018-10-08', 'DAY', T)).toMatchObject({ years: 7, text: '7 years' });
    expect(ageOf('2025-10-07', 'DAY', T)?.text).toBe('1 year');
    expect(ageOf('2025-08-20', 'DAY', T)?.text).toBe('1 year 1 month');
    expect(ageOf('2026-09-20', 'DAY', T)?.text).toBe('2 weeks');
    expect(ageOf('2026-10-06', 'DAY', T)?.text).toBe('1 day');
  });
  it('unknown, unreadable or future dates give no age (never a guess)', () => {
    expect(ageOf(null, 'UNKNOWN', T)).toBeNull();
    expect(ageOf('2018-01-01', 'UNKNOWN', T)).toBeNull();
    expect(ageOf('not a date', 'DAY', T)).toBeNull();
    expect(ageOf('2027-01-01', 'YEAR', T)).toBeNull();
    expect(ageOf('2026-10-08', 'DAY', T)).toBeNull();
  });
});

describe('parseVagueDate / formatVagueDate', () => {
  it('a year, a month or a day, stored as the first day of the period', () => {
    expect(parseVagueDate('2018')).toEqual({ on: '2018-01-01', precision: 'YEAR' });
    expect(parseVagueDate(' 2018-3 ')).toEqual({ on: '2018-03-01', precision: 'MONTH' });
    expect(parseVagueDate('2018-03-14')).toEqual({ on: '2018-03-14', precision: 'DAY' });
  });
  it('refuses impossible dates and anything else', () => {
    for (const bad of ['2018-13', '2018-02-30', '18', 'about 2018', '', 1999, null, '1800']) expect(parseVagueDate(bad)).toBeNull();
  });
  it('round-trips to what the person typed', () => {
    expect(formatVagueDate('2018-01-01', 'YEAR')).toBe('2018');
    expect(formatVagueDate('2018-03-01', 'MONTH')).toBe('2018-03');
    expect(formatVagueDate('2018-03-14', 'DAY')).toBe('2018-03-14');
    expect(formatVagueDate(null, 'UNKNOWN')).toBeNull();
  });
});
