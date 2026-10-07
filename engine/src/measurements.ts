// Weight and other measurements of an animal (spec sec 3.5, 9.4 "Weight"; S3, A16). A person's reading is an "Our
// note" (OWNER_OBSERVATION), CONFIRMED by them. Owner / Primary carer / Family may add one (sec 7.2 "weights");
// a Viewer may not. An unusual reading is never saved silently: the engine answers 409 with the question (and a
// suggested value) and saves only when the person sends confirm_unusual: true -- which is recorded on the row.
// Charts, the change since last, and the Home card use CONFIRMED rows only.
import { Decimal } from 'decimal.js';
import { requireOn } from './access.js';
import { parseVagueDate, todayIso } from './age.js';
import type { Client } from './db.js';
import { bad, conflict, notFound } from './errors.js';
import { MEASURE_CODES, measureDef, normalise, plausibility, withChanges, type Previous } from './measures.js';
import { insertRow, manualProvenance } from './provenance.js';
import { S, bodyChecker } from './validate.js';

export interface MeasurementView {
  id: number;
  measure: string;
  value: string; // stored unit, as text (no float rounding)
  unit: string;
  value_as_entered: string;
  unit_as_entered: string;
  on: string; // YYYY-MM-DD
  change: string | null; // since the previous reading of the same measure, "+0.2" / "-0.1" / "0"
  unusual_confirmed: boolean;
  by: string;
  note: string | null;
}

interface NewMeasurement { measure: string; value: number | string; unit: string; on?: string | null; note?: string | null; confirm_unusual?: boolean }
const checkNew = bodyChecker<NewMeasurement>(S.object({
  measure: S.oneOf(MEASURE_CODES),
  value: { type: ['number', 'string'] },
  unit: { type: 'string', maxLength: 8 },
  on: S.date(),
  note: S.text(500),
  confirm_unusual: { type: 'boolean' },
}, ['measure', 'value', 'unit']));

/** observed_at for a day-precision reading: midday UTC, which is the same calendar day in Dublin all year. */
export const middayOf = (d: string): string => `${d}T12:00:00Z`;

export async function listMeasurements(c: Client, animalId: number, member: string, measure?: string): Promise<MeasurementView[]> {
  await requireOn(c, animalId, member, 'VIEW');
  if (measure !== undefined) measureDef(measure);
  const r = await c.query<{ id: string; measure: string; value: string; unit: string; value_as_entered: string; unit_as_entered: string; on: string; unusual_confirmed: boolean; by: string; note: string | null }>(
    `SELECT measurement_id::text AS id, measure, value::text, unit, value_as_entered, unit_as_entered,
            to_char(observed_at AT TIME ZONE 'Europe/Dublin', 'YYYY-MM-DD') AS on, plausibility_confirmed AS unusual_confirmed, confirmed_by AS by, note
       FROM health.measurement
      WHERE animal_id = $1 AND status = 'CONFIRMED' AND ($2::text IS NULL OR measure = $2)
      ORDER BY measure, observed_at, measurement_id`,
    [animalId, measure ?? null],
  );
  const by = new Map<string, typeof r.rows>();
  for (const row of r.rows) by.set(row.measure, [...(by.get(row.measure) ?? []), row]);
  return [...by.values()].flatMap((rows) => withChanges(rows.map((x) => ({ ...x, value: new Decimal(x.value).toString() }))))
    .map((x) => ({ ...x, id: Number(x.id) }));
}

export async function moduleOfAnimal(c: Client, animalId: number): Promise<string> {
  const r = await c.query<{ module_code: string }>('SELECT module_code FROM animal.animal WHERE animal_id = $1', [animalId]);
  if (!r.rows[0]) throw notFound('no such animal');
  return r.rows[0].module_code;
}

/** The nearest confirmed reading at or before `on` (else the first one after it): what a new reading is compared with. */
export async function previousReading(c: Client, animalId: number, measure: string, on: string): Promise<Previous | null> {
  const r = await c.query<{ value: string; unit: string; on: string }>(
    `SELECT value::text, unit, to_char(observed_at AT TIME ZONE 'Europe/Dublin', 'YYYY-MM-DD') AS on FROM health.measurement
      WHERE animal_id = $1 AND measure = $2 AND status = 'CONFIRMED'
      ORDER BY (observed_at <= $3::timestamptz) DESC, CASE WHEN observed_at <= $3::timestamptz THEN observed_at END DESC NULLS LAST, observed_at ASC
      LIMIT 1`,
    [animalId, measure, middayOf(on)],
  );
  const p = r.rows[0];
  return p ? { value: new Decimal(p.value), unit: p.unit, on: p.on } : null;
}

export async function addMeasurement(c: Client, ws: number, animalId: number, member: string, body: unknown, today = todayIso()): Promise<MeasurementView[]> {
  await requireOn(c, animalId, member, 'ADD_MEDIA');
  const b = checkNew(body);
  const on = b.on ? parseVagueDate(b.on) : { on: today, precision: 'DAY' as const };
  if (!on || on.precision !== 'DAY') throw bad('on must be a date (2026-10-07)');
  if (on.on > today) throw bad('a reading cannot be in the future');
  const n = normalise(b.measure, b.value, b.unit);
  const p = plausibility(n, await previousReading(c, animalId, n.measure, on.on), await moduleOfAnimal(c, animalId));
  if (!p.ok && b.confirm_unusual !== true) {
    // Nothing is saved. The person answers: "yes, that's right" (confirm_unusual) or takes the suggestion.
    throw conflict(p.question, { needs_confirmation: true, question: p.question, suggestion: p.suggestion });
  }
  await insertRow(c, 'health.measurement', 'measurement_id', {
    workspace_id: ws, animal_id: animalId, measure: n.measure, value: n.value.toString(), unit: n.unit,
    value_as_entered: n.entered.value.toString(), unit_as_entered: n.entered.unit,
    observed_at: middayOf(on.on), time_precision: 'DAY', plausibility_confirmed: !p.ok,
    note: b.note?.trim() || null, created_by: member,
    ...manualProvenance(member, 'OWNER_OBSERVATION', true),
  });
  return listMeasurements(c, animalId, member, n.measure);
}

export interface LatestWeight { kg: string; on: string; change_kg: string | null }
/** The latest confirmed weight of every animal in the household (for cards and Overview), with its change since last. */
export async function latestWeights(c: Client): Promise<Map<number, LatestWeight>> {
  const r = await c.query<{ animal_id: string; value: string; prev: string | null; on: string }>(
    `SELECT animal_id::text, value::text, prev::text, to_char(observed_at AT TIME ZONE 'Europe/Dublin', 'YYYY-MM-DD') AS on FROM (
       SELECT animal_id, value, observed_at,
              lag(value) OVER (PARTITION BY animal_id ORDER BY observed_at, measurement_id) AS prev,
              row_number() OVER (PARTITION BY animal_id ORDER BY observed_at DESC, measurement_id DESC) AS rn
         FROM health.measurement WHERE measure = 'weight' AND status = 'CONFIRMED' AND animal_id IS NOT NULL) x
      WHERE rn = 1`,
  );
  return new Map(r.rows.map((x) => {
    const v = new Decimal(x.value);
    const d = x.prev === null ? null : v.minus(x.prev);
    return [Number(x.animal_id), { kg: v.toString(), on: x.on, change_kg: d === null ? null : d.isZero() ? '0' : `${d.isPositive() ? '+' : ''}${d.toString()}` }];
  }));
}
