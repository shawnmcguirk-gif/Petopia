// What an animal eats (spec sec 3.5 diet.feeding_plan, appendix A "Feeding"; S3, A15). History is kept: changing the
// food closes the current row with an end date (to_on = the day the new food started) and inserts the new one, in one
// transaction under a row lock. Nothing is overwritten -- the database refuses it too (migration 008's append-only
// guard: only to_on may be set, once). Owner / Primary carer only (sec 7.2 "feeding plan"); everyone may look.
import { requireOn } from './access.js';
import { parseVagueDate, todayIso } from './age.js';
import type { Client } from './db.js';
import { bad } from './errors.js';
import { parseAmount } from './measures.js';
import { badgeFor, insertRow, manualProvenance, type Badge } from './provenance.js';
import { S, bodyChecker } from './validate.js';

export const FOOD_TYPES = ['DRY', 'WET', 'RAW', 'MIXED', 'PELLET', 'FLAKE', 'HAY', 'LIVE', 'OTHER'] as const;
export const PORTION_UNITS = ['g', 'kg', 'ml', 'cup', 'can', 'pouch', 'scoop', 'tbsp', 'piece'] as const;

export interface FeedingView {
  id: number;
  brand: string | null;
  product: string | null;
  food_type: string;
  portion_amount: string | null;
  portion_unit: string | null;
  times: string[];
  from_on: string;
  to_on: string | null;
  objective: string | null;
  notes: string | null;
  badge: Badge;
  by: string;
}

interface NewFeeding {
  brand?: string | null; product?: string | null; food_type: string; portion_amount?: number | string | null; portion_unit?: string | null;
  times?: string[]; from_on?: string | null; objective?: string | null; notes?: string | null; source?: 'OWNER_OBSERVATION' | 'VET_ADVICE';
}
const checkNew = bodyChecker<NewFeeding>(S.object({
  brand: S.text(80), product: S.text(120), food_type: S.oneOf(FOOD_TYPES),
  portion_amount: S.number(), portion_unit: { type: ['string', 'null'], enum: [...PORTION_UNITS, null] },
  times: { type: 'array', maxItems: 8, items: { type: 'string', pattern: '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' } },
  from_on: S.date(), objective: S.text(200), notes: S.text(500),
  source: S.oneOf(['OWNER_OBSERVATION', 'VET_ADVICE']),
}, ['food_type']));

const COLS = `feeding_plan_id::text AS id, brand, product, food_type, portion_amount::text, portion_unit, times, from_on, to_on, objective, notes,
              source_class, status, channel, coalesce(confirmed_by, proposed_by) AS by`;
type Row = Omit<FeedingView, 'id' | 'badge'> & { id: string; source_class: string; status: string; channel: string };
const view = (r: Row): FeedingView => ({
  id: Number(r.id), brand: r.brand, product: r.product, food_type: r.food_type, portion_amount: r.portion_amount === null ? null : String(Number(r.portion_amount)),
  portion_unit: r.portion_unit, times: r.times ?? [], from_on: r.from_on, to_on: r.to_on, objective: r.objective, notes: r.notes,
  badge: badgeFor(r), by: r.by,
});

/** The current food and the history (newest first). */
export async function getFeeding(c: Client, animalId: number, member: string): Promise<{ current: FeedingView | null; history: FeedingView[] }> {
  await requireOn(c, animalId, member, 'VIEW');
  const r = await c.query<Row>(`SELECT ${COLS} FROM diet.feeding_plan WHERE animal_id = $1 AND status = 'CONFIRMED' ORDER BY from_on DESC, feeding_plan_id DESC`, [animalId]);
  const all = r.rows.map(view);
  return { current: all.find((x) => x.to_on === null) ?? null, history: all.filter((x) => x.to_on !== null) };
}

const clean = (s: string | null | undefined): string | null => (s ?? '').trim() || null;
const hhmm = (t: string): string => t.padStart(5, '0');

/** Sets a new current food. The old one (if any) ends on the day the new one starts. */
export async function setFeeding(c: Client, ws: number, animalId: number, member: string, body: unknown, today = todayIso()) {
  await requireOn(c, animalId, member, 'MANAGE_CARE');
  const b = checkNew(body);
  const brand = clean(b.brand);
  const product = clean(b.product);
  if (!brand && !product) throw bad('give the brand or the product name');
  const amount = b.portion_amount === undefined || b.portion_amount === null || b.portion_amount === '' ? null : parseAmount(b.portion_amount, 'portion_amount');
  if ((amount === null) !== (b.portion_unit === undefined || b.portion_unit === null)) throw bad('a portion needs both an amount and a unit');
  const from = b.from_on ? parseVagueDate(b.from_on) : { on: today, precision: 'DAY' as const };
  if (!from || from.precision !== 'DAY') throw bad('from_on must be a date');
  if (from.on > today) throw bad('the new food cannot start in the future');
  const times = [...new Set((b.times ?? []).map(hhmm))].sort();

  const cur = await c.query<{ id: string; from_on: string }>(
    `SELECT feeding_plan_id::text AS id, from_on FROM diet.feeding_plan WHERE animal_id = $1 AND to_on IS NULL AND status = 'CONFIRMED' FOR UPDATE`,
    [animalId],
  );
  const old = cur.rows[0];
  if (old) {
    if (from.on < old.from_on) throw bad(`the new food must start on or after ${old.from_on}, when the current one started`);
    await c.query('UPDATE diet.feeding_plan SET to_on = $2 WHERE feeding_plan_id = $1', [old.id, from.on]);
  }
  await insertRow(c, 'diet.feeding_plan', 'feeding_plan_id', {
    workspace_id: ws, animal_id: animalId, brand, product, food_type: b.food_type,
    portion_amount: amount?.toString() ?? null, portion_unit: amount === null ? null : b.portion_unit, times,
    from_on: from.on, objective: clean(b.objective), notes: clean(b.notes), created_by: member,
    ...manualProvenance(member, b.source ?? 'OWNER_OBSERVATION', true),
  });
  return getFeeding(c, animalId, member);
}

export interface FoodSummary { brand: string | null; product: string | null; food_type: string; portion_amount: string | null; portion_unit: string | null; times: string[]; from_on: string }
/** Every animal's current food, for cards and Overview. */
export async function currentFoods(c: Client): Promise<Map<number, FoodSummary>> {
  const r = await c.query<FoodSummary & { animal_id: string }>(
    `SELECT animal_id::text, brand, product, food_type, portion_amount::text, portion_unit, times, from_on
       FROM diet.feeding_plan WHERE to_on IS NULL AND status = 'CONFIRMED'`,
  );
  return new Map(r.rows.map(({ animal_id, ...f }) => [Number(animal_id), { ...f, portion_amount: f.portion_amount === null ? null : String(Number(f.portion_amount)), times: f.times ?? [] }]));
}
