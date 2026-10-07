// The measurement registry and the plausibility question (spec sec 9.4 "Weight"; S3, A16). Pure.
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { normalise, plausibility, withChanges, MEASURES, MEASURE_CODES } from '../src/measures.js';

const prev = (v: string, on = '2026-10-01') => ({ value: new Decimal(v), unit: 'kg', on });

describe('normalise', () => {
  it('stores weight in kg: kg as typed, g and lb converted with decimal.js', () => {
    expect(normalise('weight', 6.1, 'kg').value.toString()).toBe('6.1');
    expect(normalise('weight', '6,1', 'kg').value.toString()).toBe('6.1'); // comma decimal
    expect(normalise('weight', 6100, 'g').value.toString()).toBe('6.1');
    expect(normalise('weight', 10, 'lb').value.toString()).toBe('4.536');
    expect(normalise('weight', 10, 'lb').entered).toMatchObject({ unit: 'lb' });
  });
  it('length/height in cm; inches and mm converted', () => {
    expect(normalise('length', 10, 'in').value.toString()).toBe('25.4');
    expect(normalise('height', 250, 'mm')).toMatchObject({ unit: 'cm' });
  });
  it('body condition score stays in its own scale; out-of-scale or wrong steps refused', () => {
    expect(normalise('bcs', 5, '/9')).toMatchObject({ unit: '/9' });
    expect(normalise('bcs', '3.5', '/5').value.toString()).toBe('3.5');
    expect(() => normalise('bcs', 10, '/9')).toThrow(/1 to 9/);
    expect(() => normalise('bcs', 4.5, '/9')).toThrow();
    expect(() => normalise('bcs', 3.3, '/5')).toThrow();
  });
  it('refuses unknown measures and units, zero, negatives, words and 4+ decimals', () => {
    expect(() => normalise('temperature', 38, 'C')).toThrow(/measure must be/);
    expect(() => normalise('weight', 6, 'stone')).toThrow(/kg, g, lb/);
    for (const v of [0, -1, 'six', '6.1234', null]) expect(() => normalise('weight', v, 'kg')).toThrow();
  });
  it('every measure has its stored unit among the units it accepts (or is a score)', () => {
    for (const c of MEASURE_CODES) {
      const m = MEASURES[c];
      if (m.stored) expect(Object.keys(m.units)).toContain(m.stored);
    }
  });
});

describe('plausibility (S3 acceptance: 61 for a 6.1 kg dog asks "did you mean 6.1?")', () => {
  it('61 kg after 6.1 kg -> a question suggesting 6.1 kg; nothing is decided for the person', () => {
    const p = plausibility(normalise('weight', 61, 'kg'), prev('6.1'), 'dog');
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.suggestion).toEqual({ value: '6.1', unit: 'kg' });
      expect(p.question).toMatch(/did you mean 6\.1 kg\?/i);
      expect(p.question).toContain('6.1 kg on 2026-10-01');
    }
  });
  it('0.61 kg after 6.1 kg -> suggests 6.1 kg; 6.1 typed as lb -> suggests kg', () => {
    const a = plausibility(normalise('weight', '0.61', 'kg'), prev('6.1'), 'dog');
    expect(!a.ok && a.suggestion).toEqual({ value: '6.1', unit: 'kg' });
    const b = plausibility(normalise('weight', 13.4, 'kg'), prev('6.1'), 'dog'); // 13.4 lb = 6.078 kg
    expect(!b.ok && b.suggestion).toEqual({ value: '13.4', unit: 'lb' });
  });
  it('a normal change passes; a big change with no likely slip asks "is that right?" with no suggestion', () => {
    expect(plausibility(normalise('weight', 6.3, 'kg'), prev('6.1'), 'dog')).toEqual({ ok: true });
    const p = plausibility(normalise('weight', 8.5, 'kg'), prev('6.1'), 'dog');
    expect(p).toMatchObject({ ok: false, suggestion: null });
    if (!p.ok) expect(p.question).toMatch(/is that right\?/i);
  });
  it('first reading: only wide typing-slip bounds per module (never a breed average)', () => {
    expect(plausibility(normalise('weight', 61, 'kg'), null, 'dog')).toEqual({ ok: true }); // a big dog is possible
    const cat = plausibility(normalise('weight', 42, 'kg'), null, 'cat');
    expect(cat.ok).toBe(false);
    if (!cat.ok) {
      expect(cat.suggestion).toEqual({ value: '4.2', unit: 'kg' });
      expect(cat.question).not.toMatch(/average|breed|healthy|overweight|underweight/i);
    }
    expect(plausibility(normalise('bcs', 9, '/9'), null, 'dog')).toEqual({ ok: true });
  });
});

describe('withChanges', () => {
  it('change since the previous reading, same unit only', () => {
    const rows = withChanges([
      { value: '6.1', unit: 'kg', on: '2026-09-01' },
      { value: '6.3', unit: 'kg', on: '2026-10-01' },
      { value: '6.3', unit: 'kg', on: '2026-10-05' },
      { value: '6.05', unit: 'kg', on: '2026-10-07' },
    ]);
    expect(rows.map((r) => r.change)).toEqual([null, '+0.2', '0', '-0.25']);
    expect(withChanges([{ value: '5', unit: '/9', on: 'a' }, { value: '3', unit: '/5', on: 'b' }])[1]!.change).toBeNull();
  });
});
