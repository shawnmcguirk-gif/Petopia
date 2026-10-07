// The routine schedule subset and medication supply (spec sec 3.5; S6, A22, A24). Pure.
import { describe, expect, it } from 'vitest';
import { supplyDaysLeft } from '../src/care.js';
import { dublinToIso, eventPayload } from '../src/calendar.js';
import { lastOnOrBefore, occurrences, occursOn, parseRule, perDay } from '../src/rrule.js';

describe('rrule subset', () => {
  it('parses only what it supports', () => {
    expect(parseRule('FREQ=DAILY')).toEqual({ freq: 'DAILY', interval: 1, byday: null });
    expect(parseRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH')).toEqual({ freq: 'WEEKLY', interval: 2, byday: [0, 3] });
    expect(parseRule('FREQ=MONTHLY;BYDAY=MO')).toBeNull();
    expect(parseRule('FREQ=HOURLY')).toBeNull();
    expect(parseRule('FREQ=DAILY;COUNT=3')).toBeNull();
  });
  it('daily every n, weekly on days, monthly clamped to the month end, yearly', () => {
    const d2 = parseRule('FREQ=DAILY;INTERVAL=2')!;
    expect(occurrences(d2, '2026-10-01', '2026-10-01', '2026-10-07')).toEqual(['2026-10-01', '2026-10-03', '2026-10-05', '2026-10-07']);
    const w = parseRule('FREQ=WEEKLY;BYDAY=MO,TH')!; // 2026-10-05 is a Monday
    expect(occurrences(w, '2026-10-01', '2026-10-01', '2026-10-12')).toEqual(['2026-10-01', '2026-10-05', '2026-10-08', '2026-10-12']);
    const m = parseRule('FREQ=MONTHLY')!;
    expect(occurrences(m, '2026-01-31', '2026-01-01', '2026-04-30')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    expect(occursOn(parseRule('FREQ=YEARLY')!, '2025-10-02', '2026-10-02')).toBe(true);
    expect(occursOn(parseRule('FREQ=YEARLY')!, '2025-10-02', '2026-10-03')).toBe(false);
    expect(occursOn(d2, '2026-10-01', '2026-09-29')).toBe(false); // nothing before the start
  });
  it('the last occurrence on or before a day (an overdue monthly flea treatment)', () => {
    expect(lastOnOrBefore(parseRule('FREQ=MONTHLY')!, '2026-08-15', '2026-10-07')).toBe('2026-09-15');
    expect(lastOnOrBefore(parseRule('FREQ=WEEKLY')!, '2026-10-08', '2026-10-07')).toBeNull();
  });
  it('per day', () => {
    expect(perDay(parseRule('FREQ=DAILY')!)).toBe(1);
    expect(perDay(parseRule('FREQ=WEEKLY;BYDAY=MO,TH')!)).toBeCloseTo(2 / 7);
  });
});

describe('medication supply (sec 3.5)', () => {
  it('remaining doses over doses a day; never negative; null without a schedule', () => {
    const twiceDaily = [{ rule: parseRule('FREQ=DAILY')!, slots: 2, doses: 1 }];
    expect(supplyDaysLeft(30, 16, twiceDaily)).toBe(7);
    expect(supplyDaysLeft(30, 40, twiceDaily)).toBe(0);
    expect(supplyDaysLeft(30, 0, [])).toBeNull();
  });
});

describe('calendar payload (copied from Vitalis calendar.ts)', () => {
  it('Dublin wall clock to an instant, summer and winter', () => {
    expect(dublinToIso('2026-07-01', '09:30')).toBe('2026-07-01T08:30:00.000Z');
    expect(dublinToIso('2026-12-01', '09:30')).toBe('2026-12-01T09:30:00.000Z');
  });
  it('title names the animal; a time gives a reminder, no time is all-day', () => {
    const p = eventPayload({ id: 1, ws: 1, with_whom: 'vet — annual vaccination', scheduled_on: '2026-11-02', scheduled_time: '10:15', reason: 'annual vaccination', calendar_event_id: null }, 'Biscuit', false)!;
    expect(p.title).toBe('Biscuit: vet — annual vaccination');
    expect(p.reminder_minutes).toBe(120);
    expect(eventPayload({ id: 1, ws: 1, with_whom: 'vet', scheduled_on: '2026-11-02', scheduled_time: null, reason: null, calendar_event_id: null }, 'Biscuit', false)!.all_day).toBe(true);
  });
});
