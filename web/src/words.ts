// Plain words for stored codes (CONVENTIONS sec 32). Only real data is ever turned into words; nothing is invented.
import type { Animal } from './api';

export const HEALTH_WORDS: Record<NonNullable<Animal['health_status']>, string> = {
  HEALTHY: 'Healthy',
  UNDER_TREATMENT: 'Under treatment',
  NEEDS_ATTENTION: 'Needs attention',
};
export const SEX_WORDS: Record<Animal['sex'], string | null> = { FEMALE: 'Female', MALE: 'Male', UNKNOWN: null };
export const NEUTER_WORDS: Record<Animal['neuter_status'], string | null> = { NEUTERED: 'Yes', ENTIRE: 'No', UNKNOWN: null };

/** "Shih Tzu · about 8 years · 6.1 kg" -- each part only when it is known. */
export function summaryLine(a: Pick<Animal, 'species' | 'breed' | 'age' | 'latest_weight'>): string {
  const parts = [a.breed || a.species];
  if (a.age) parts.push(a.age.text);
  if (a.latest_weight) parts.push(`${Number(a.latest_weight.kg)} kg`);
  return parts.join(' · ');
}

export const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;
