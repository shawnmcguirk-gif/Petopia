// An animal's Timeline (spec sec 3.6; S4, A19): every event from the one view timeline.entry_v (migration 010), newest
// first, each with its source badge (sec 4.1). Filters: All, Health, Food, Weight (Care and Memories arrive with S6 /
// v1.1). Superseded and disputed rows never appear; rows waiting for a person's check appear with that badge.
import { requireOn } from './access.js';
import { formatVagueDate, type Precision } from './age.js';
import type { Client } from './db.js';
import { bad } from './errors.js';
import { badgeFor, type Badge } from './provenance.js';

export const CATEGORIES = ['HEALTH', 'FOOD', 'WEIGHT'] as const;
export type Category = (typeof CATEGORIES)[number];

const KIND_WORDS: Record<string, string> = {
  VET_VISIT: 'Vet visit', VACCINATION: 'Vaccination', CONDITION: 'Condition', ALLERGY: 'Allergy', PROCEDURE: 'Procedure', LAB_RESULT: 'Lab result',
  TREATMENT_FLEA: 'Flea treatment', TREATMENT_WORM: 'Worming', TREATMENT_TICK: 'Tick treatment', TREATMENT_DENTAL: 'Dental treatment', TREATMENT_OTHER: 'Treatment',
  MEDICATION_PRESCRIBED: 'Medicine prescribed', MEDICATION_STARTED: 'Medicine started', MEDICATION_DOSE_CHANGED: 'Dose changed', MEDICATION_STOPPED: 'Medicine stopped',
  MEASUREMENT_WEIGHT: 'Weight', MEASUREMENT_LENGTH: 'Length', MEASUREMENT_HEIGHT: 'Height', MEASUREMENT_BCS: 'Body condition score',
  FOOD_STARTED: 'New food',
};
export const kindWords = (k: string): string => KIND_WORDS[k] ?? 'Entry';

export interface TimelineEntry {
  on: string; // as precise as it is known: "2025", "2025-10", "2025-10-03"
  sort_on: string;
  year: string;
  category: string;
  kind: string;
  label: string;
  title: string;
  detail: string | null;
  badge: Badge;
  ref: { table: string; id: number };
}

export async function getTimeline(c: Client, animalId: number, member: string, category?: string): Promise<TimelineEntry[]> {
  await requireOn(c, animalId, member, 'VIEW');
  if (category !== undefined && !(CATEGORIES as readonly string[]).includes(category)) throw bad(`category must be one of ${CATEGORIES.join(', ')}`);
  const r = await c.query<{ on_date: string; precision: Precision; category: string; kind: string; title: string; detail: string | null; source_class: string; status: string; channel: string; ref_table: string; ref_id: string }>(
    `SELECT on_date, precision, category, kind, title, detail, source_class, status, channel, ref_table, ref_id::text
       FROM timeline.entry_v WHERE animal_id = $1 AND ($2::text IS NULL OR category = $2)
      ORDER BY on_date DESC, created_at DESC`,
    [animalId, category ?? null],
  );
  return r.rows.map((x) => ({
    on: formatVagueDate(x.on_date, x.precision) ?? x.on_date, sort_on: x.on_date, year: x.on_date.slice(0, 4), category: x.category, kind: x.kind,
    label: kindWords(x.kind), title: x.title, detail: x.detail, badge: badgeFor(x), ref: { table: x.ref_table, id: Number(x.ref_id) },
  }));
}
