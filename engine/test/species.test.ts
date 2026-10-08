// Species modules validated by ajv (spec sec 3.3, A6). Fixtures are fictional ("Biscuit", a cat).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertExt, extProblems, type SpeciesModule } from '../src/species.js';

const file = (code: string) => readFileSync(new URL(`../schemas/species/${code}.json`, import.meta.url), 'utf8');
const mod = (code: string): SpeciesModule => ({ code, schema: JSON.parse(file(code)) as Record<string, unknown>, schema_version: 1 });
const dog = mod('dog');
const cat = mod('cat');
const NEW = ['small_mammal', 'cage_bird', 'poultry', 'reptile', 'amphibian', 'aquarium_fish', 'equine', 'other'];

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
  it('migrations 004 and 015 carry byte-identical copies of the schema files (no drift)', () => {
    const sql = (n: string) => readFileSync(new URL(`../../migrations/${n}`, import.meta.url), 'utf8');
    const where: Record<string, string> = { dog: '004_ref.sql', cat: '004_ref.sql' };
    for (const code of NEW) where[code] = '015_any_animal.sql';
    for (const [code, mig] of Object.entries(where)) {
      const m = new RegExp(`\\$${code}\\$([\\s\\S]*?)\\$${code}\\$`).exec(sql(mig));
      expect(m?.[1], code).toBe(file(code).trim());
    }
  });
  it('every new module accepts an empty extension and refuses fields from elsewhere', () => {
    for (const code of NEW) {
      expect(extProblems(mod(code), {}), code).toEqual([]);
      expect(extProblems(mod(code), { coat_type: 'LONG' })[0], code).toBe('coat_type is not a ' + code + ' field');
    }
  });
  it('the new modules take their own fields and bound them', () => {
    expect(extProblems(mod('small_mammal'), { housing: 'BOTH' })).toEqual([]);
    expect(extProblems(mod('cage_bird'), { ring_number: 'IE-123', wings_clipped: false })).toEqual([]);
    expect(extProblems(mod('reptile'), { basking_temp_target_c: 38, uvb_lamp_changed_on: '2026-09-01' })).toEqual([]);
    expect(extProblems(mod('reptile'), { uvb_lamp_changed_on: 'last month' }).length).toBeGreaterThan(0);
    expect(extProblems(mod('aquarium_fish'), { water_type: 'FRESH', group_size: 6 })).toEqual([]);
    expect(extProblems(mod('aquarium_fish'), { water_type: 'LAKE' })[0]).toBe('water_type must be one of FRESH, MARINE, BRACKISH');
    expect(extProblems(mod('equine'), { height_hands: 15.2 })).toEqual([]);
    expect(extProblems(mod('equine'), { height_hands: 99 })[0]).toMatch(/height_hands must be <= 30/);
    expect(extProblems(mod('other'), { species_name: 'Tarantula' })).toEqual([]);
    expect(extProblems(mod('other'), { species_name: '' }).length).toBeGreaterThan(0);
  });
});
