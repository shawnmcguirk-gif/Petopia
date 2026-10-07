// Species modules validated by ajv (spec sec 3.3, A6). Fixtures are fictional ("Biscuit", a cat).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertExt, extProblems, type SpeciesModule } from '../src/species.js';

const file = (code: string) => readFileSync(new URL(`../schemas/species/${code}.json`, import.meta.url), 'utf8');
const mod = (code: string): SpeciesModule => ({ code, schema: JSON.parse(file(code)) as Record<string, unknown>, schema_version: 1 });
const dog = mod('dog');
const cat = mod('cat');

describe('species modules', () => {
  it('accepts valid dog and cat extensions, and an empty one', () => {
    expect(extProblems(dog, { coat_type: 'LONG', walk_minutes_target: 40, kennel_club_reg: 'KC-123' })).toEqual([]);
    expect(extProblems(cat, { indoor_outdoor: 'INDOOR', coat_type: 'SHORT' })).toEqual([]);
    expect(extProblems(dog, {})).toEqual([]);
  });
  it('refuses a field from another species, wrong types, out-of-range numbers and unknown enum values', () => {
    expect(extProblems(cat, { walk_minutes_target: 30 })).toEqual(['walk_minutes_target is not a cat field']);
    expect(extProblems(dog, { walk_minutes_target: 'lots' })[0]).toMatch(/walk_minutes_target must be integer/);
    expect(extProblems(dog, { walk_minutes_target: 9999 })[0]).toMatch(/walk_minutes_target must be <= 600/);
    expect(extProblems(cat, { indoor_outdoor: 'GARDEN' })[0]).toBe('indoor_outdoor must be one of INDOOR, OUTDOOR, BOTH');
    expect(extProblems(dog, ['not', 'an', 'object']).length).toBeGreaterThan(0);
  });
  it('assertExt throws 422 listing every problem', () => {
    expect(() => assertExt(cat, { indoor_outdoor: 'X', wings_clipped: true })).toThrow(expect.objectContaining({ status: 422 }) as Error);
    expect(assertExt(cat, { indoor_outdoor: 'BOTH' })).toEqual({ indoor_outdoor: 'BOTH' });
  });
  it('migration 004 carries byte-identical copies of the schema files (no drift)', () => {
    const sql = readFileSync(new URL('../../migrations/004_ref.sql', import.meta.url), 'utf8');
    for (const code of ['dog', 'cat']) {
      const m = new RegExp(`\\$${code}\\$([\\s\\S]*?)\\$${code}\\$`).exec(sql);
      expect(m?.[1]).toBe(file(code).trim());
    }
  });
});
