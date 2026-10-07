// Medication (spec sec 3.5 health.medication + medication_event; S4, A18). The medicine is a "thing"; what happens to
// it is a dated event (PRESCRIBED, STARTED, DOSE_CHANGED, STOPPED). The CURRENT list is never stored: it is derived
// from confirmed events, as Vitalis currentRegimen -- a medicine whose latest event is STOPPED is not current.
// Owner / Primary carer only (sec 7.2 "Add or change medication"); everyone may look.
import { requireOn } from './access.js';
import type { Client } from './db.js';
import { bad, conflict, notFound } from './errors.js';
import { parseAmount } from './measures.js';
import { badgeFor, insertRow, manualProvenance, MANUAL_SOURCES, type Badge, type ManualSource } from './provenance.js';
import { checkContact, checkVisit, vagueOrToday } from './records.js';
import { S, bodyChecker } from './validate.js';

export const EVENT_KINDS = ['PRESCRIBED', 'STARTED', 'DOSE_CHANGED', 'STOPPED'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface MedEvent {
  id: number;
  medication_id: number;
  product_name: string;
  strength: string | null;
  event_kind: EventKind;
  event_on: string;
  dose_text: string | null;
  dose_amount: string | null;
  dose_unit: string | null;
  frequency: string | null;
  instructions_verbatim: string | null;
  reason: string | null;
  status: string;
  source_class: string;
  channel: string;
}

export interface CurrentMedicine {
  medication_id: number;
  product_name: string;
  strength: string | null;
  dose: string | null;
  frequency: string | null;
  instructions: string | null;
  since: string; // the start of the current run (after the last stop)
  last_event_on: string;
}

const doseOf = (e: Pick<MedEvent, 'dose_text' | 'dose_amount' | 'dose_unit'>): string | null =>
  e.dose_text ?? (e.dose_amount !== null ? `${Number(e.dose_amount)} ${e.dose_unit ?? ''}`.trim() : null);

/**
 * Pure derivation of the current list from CONFIRMED events (anything else is ignored). Events are ordered by date,
 * then by id (entry order). A medicine is current when its latest event is not STOPPED; its dose is the latest dosed
 * event of the current run.
 */
export function deriveCurrent(events: MedEvent[]): CurrentMedicine[] {
  const by = new Map<number, MedEvent[]>();
  for (const e of events.filter((x) => x.status === 'CONFIRMED')) by.set(e.medication_id, [...(by.get(e.medication_id) ?? []), e]);
  const out: CurrentMedicine[] = [];
  for (const list of by.values()) {
    list.sort((a, b) => a.event_on.localeCompare(b.event_on) || a.id - b.id);
    const last = list[list.length - 1]!;
    if (last.event_kind === 'STOPPED') continue;
    const lastStop = list.map((e) => e.event_kind).lastIndexOf('STOPPED');
    const run = list.slice(lastStop + 1);
    const dosed = [...run].reverse().find((e) => doseOf(e) !== null || e.frequency !== null);
    out.push({
      medication_id: last.medication_id, product_name: last.product_name, strength: last.strength,
      dose: dosed ? doseOf(dosed) : null, frequency: dosed?.frequency ?? null,
      instructions: [...run].reverse().find((e) => e.instructions_verbatim)?.instructions_verbatim ?? null,
      since: run[0]!.event_on, last_event_on: last.event_on,
    });
  }
  return out.sort((a, b) => a.product_name.localeCompare(b.product_name));
}

async function events(c: Client, animalId: number | null): Promise<MedEvent[]> {
  const r = await c.query<Omit<MedEvent, 'id' | 'medication_id'> & { id: string; medication_id: string }>(
    `SELECT e.medication_event_id::text AS id, e.medication_id::text, m.product_name, m.strength, e.event_kind, e.event_on, e.dose_text,
            e.dose_amount::text, e.dose_unit, e.frequency, e.instructions_verbatim, e.reason, e.status, e.source_class, e.channel
       FROM health.medication_event e JOIN health.medication m ON m.workspace_id = e.workspace_id AND m.medication_id = e.medication_id
      WHERE ($1::bigint IS NULL OR e.animal_id = $1) AND e.status IN ('CONFIRMED','PROPOSED') AND m.retired_at IS NULL
      ORDER BY e.event_on, e.medication_event_id`,
    [animalId],
  );
  return r.rows.map((x) => ({ ...x, id: Number(x.id), medication_id: Number(x.medication_id) }));
}

export interface MedicationView { id: number; product_name: string; strength: string | null; form: string | null; current: boolean; events: (MedEvent & { badge: Badge })[] }

export async function listMedications(c: Client, animalId: number, member: string): Promise<{ current: CurrentMedicine[]; medicines: MedicationView[] }> {
  await requireOn(c, animalId, member, 'VIEW');
  const ev = await events(c, animalId);
  const current = deriveCurrent(ev);
  const meds = await c.query<{ id: string; product_name: string; strength: string | null; form: string | null }>(
    'SELECT medication_id::text AS id, product_name, strength, form FROM health.medication WHERE animal_id = $1 AND retired_at IS NULL ORDER BY lower(product_name)',
    [animalId],
  );
  const cur = new Set(current.map((x) => x.medication_id));
  return {
    current,
    medicines: meds.rows.map((m) => ({
      id: Number(m.id), product_name: m.product_name, strength: m.strength, form: m.form, current: cur.has(Number(m.id)),
      events: ev.filter((e) => e.medication_id === Number(m.id)).reverse().map((e) => ({ ...e, badge: badgeFor(e) })),
    })),
  };
}

/** Every animal's current medicines (names + dose), for Overview. */
export async function currentByAnimal(c: Client): Promise<Map<number, CurrentMedicine[]>> {
  const r = await c.query<{ medication_id: string; animal_id: string }>('SELECT medication_id::text, animal_id::text FROM health.medication');
  const owner = new Map(r.rows.map((x) => [Number(x.medication_id), Number(x.animal_id)]));
  const out = new Map<number, CurrentMedicine[]>();
  for (const m of deriveCurrent(await events(c, null))) {
    const a = owner.get(m.medication_id)!;
    out.set(a, [...(out.get(a) ?? []), m]);
  }
  return out;
}

interface EventBody {
  event_kind: EventKind; event_on?: string | null; dose_text?: string | null; dose_amount?: number | string | null; dose_unit?: string | null;
  frequency?: string | null; instructions_verbatim?: string | null; reason?: string | null; prescriber_contact_id?: number | null;
  quantity_supplied?: number | string | null; vet_visit_id?: number | null; source?: ManualSource;
}
const eventProps = {
  event_kind: S.oneOf(EVENT_KINDS), event_on: S.vagueDate(), dose_text: S.text(120), dose_amount: S.number(), dose_unit: S.text(20),
  frequency: S.text(120), instructions_verbatim: S.text(1000), reason: S.text(300), prescriber_contact_id: S.id(),
  quantity_supplied: S.number(), vet_visit_id: S.id(), source: S.oneOf(MANUAL_SOURCES),
};
const checkEvent = bodyChecker<EventBody>(S.object(eventProps, ['event_kind']));
const checkNewMed = bodyChecker<{ product_name: string; strength?: string | null; form?: string | null; start: EventBody }>(S.object({
  product_name: { type: 'string', minLength: 1, maxLength: 120 }, strength: S.text(60), form: S.text(60),
  start: S.object(eventProps, ['event_kind']),
}, ['product_name', 'start']));

const clean = (s: string | null | undefined): string | null => (s ?? '').trim() || null;
const amount = (v: unknown, f: string) => (v === undefined || v === null || v === '' ? null : parseAmount(v, f).toString());

async function writeEvent(c: Client, ws: number, animalId: number, medId: number, member: string, b: EventBody, today?: string): Promise<void> {
  const on = vagueOrToday(b.event_on, 'event_on', today);
  const dose_amount = amount(b.dose_amount, 'dose_amount');
  const dose_unit = clean(b.dose_unit);
  if ((dose_amount === null) !== (dose_unit === null)) throw bad('a dose amount needs a unit (and a unit needs an amount)');
  if (b.event_kind === 'DOSE_CHANGED' && !clean(b.dose_text) && dose_amount === null) throw bad('a dose change needs the new dose');
  await checkContact(c, b.prescriber_contact_id ?? null);
  await checkVisit(c, animalId, b.vet_visit_id ?? null);
  await insertRow(c, 'health.medication_event', 'medication_event_id', {
    workspace_id: ws, animal_id: animalId, medication_id: medId, event_kind: b.event_kind, event_on: on.on, event_precision: on.precision,
    dose_text: clean(b.dose_text), dose_amount, dose_unit, frequency: clean(b.frequency), instructions_verbatim: clean(b.instructions_verbatim),
    reason: clean(b.reason), prescriber_contact_id: b.prescriber_contact_id ?? null, quantity_supplied: amount(b.quantity_supplied, 'quantity_supplied'),
    vet_visit_id: b.vet_visit_id ?? null, created_by: member,
    ...manualProvenance(member, b.source ?? 'OWNER_OBSERVATION', true),
  });
}

/** A new medicine with its first event (usually STARTED or PRESCRIBED). */
export async function addMedication(c: Client, ws: number, animalId: number, member: string, body: unknown, today?: string) {
  await requireOn(c, animalId, member, 'MANAGE_CARE');
  const b = checkNewMed(body);
  if (b.start.event_kind === 'STOPPED' || b.start.event_kind === 'DOSE_CHANGED') throw bad('a new medicine starts with PRESCRIBED or STARTED');
  const medId = await insertRow(c, 'health.medication', 'medication_id', {
    workspace_id: ws, animal_id: animalId, product_name: b.product_name.trim(), strength: clean(b.strength), form: clean(b.form), created_by: member,
  });
  await writeEvent(c, ws, animalId, medId, member, b.start, today);
  return listMedications(c, animalId, member);
}

/** Start again, change the dose, or stop. Stopping takes it off the current list (derived, never stored). */
export async function addMedicationEvent(c: Client, ws: number, animalId: number, medId: number, member: string, body: unknown, today?: string) {
  await requireOn(c, animalId, member, 'MANAGE_CARE');
  const b = checkEvent(body);
  const m = await c.query('SELECT 1 FROM health.medication WHERE medication_id = $1 AND animal_id = $2 AND retired_at IS NULL FOR UPDATE', [medId, animalId]);
  if (!m.rowCount) throw notFound('no such medicine for this animal');
  const isCurrent = deriveCurrent((await events(c, animalId)).filter((e) => e.medication_id === medId)).length > 0;
  if (b.event_kind === 'STOPPED' && !isCurrent) throw conflict('that medicine is already stopped');
  if (b.event_kind === 'DOSE_CHANGED' && !isCurrent) throw conflict('that medicine is stopped; start it again first');
  const last = (await c.query<{ on: string | null }>("SELECT max(event_on)::text AS on FROM health.medication_event WHERE medication_id = $1 AND status = 'CONFIRMED'", [medId])).rows[0]?.on;
  if (last && vagueOrToday(b.event_on, 'event_on', today).on < last) throw bad(`this medicine already has an entry on ${last}; a new one cannot be earlier`);
  await writeEvent(c, ws, animalId, medId, member, b, today);
  return listMedications(c, animalId, member);
}
