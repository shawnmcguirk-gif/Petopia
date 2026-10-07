// Routines, the shared care log, Today / Coming Up, medication supply (spec sec 3.5, 9.3; slice S6; A22-A24).
//   - Routines come from the species module's defaults (offered, never auto-created), from a medicine, from a vet's
//     advice (linked to the confirmed record it came from), or from a person. Owner / Primary carer manage them (7.2).
//   - "Done" writes one care.log row (who, when). Logging is open to Owner / Primary carer / Family, not Viewer. The
//     occurrence key makes a second tap -- on this phone or another -- a no-op that reports who already did it.
//   - Today and Coming Up (30 days) are DERIVED on every read from routines, logs, confirmed records and appointments;
//     nothing about "due" is stored. Overdue is always computed. Empty sections are simply empty lists (UI hides them).
//   - Medication supply: remaining = quantity supplied - doses logged since; under 7 days of doses -> "Prescription
//     renewal approaching" in Coming Up (sec 3.5 "Medication supply").
// No push notifications and nothing here is sent to the Planner (sec 6: no notification noise).
import { can, requireOn, effectiveRole, type Role } from './access.js';
import { todayIso } from './age.js';
import { toId, withTxn, type Client } from './db.js';
import { syncVisit } from './calendar.js';
import { bad, conflict, notFound } from './errors.js';
import { deriveCurrent, type MedEvent } from './medications.js';
import { insertRow } from './provenance.js';
import { addDays, daysBetween, lastOnOrBefore, occurrences, occursOn, parseRule, perDay, type Rule } from './rrule.js';
import { S, bodyChecker } from './validate.js';

export const ROUTINE_KINDS = ['FEED', 'WALK', 'GROOM', 'BATH', 'NAILS', 'TEETH', 'EARS', 'MEDICATION', 'FLEA', 'WORM', 'VACCINATION', 'TANK_CLEAN', 'WATER_TEST', 'CAGE_CLEAN', 'BEDDING', 'FEEDER_REFILL', 'OTHER'] as const;
export const ORIGINS = ['SPECIES_DEFAULT', 'MEDICATION', 'VET_ADVICE', 'MANUAL'] as const;
export const HORIZON_DAYS = 30;
export const SUPPLY_WARN_DAYS = 7;

const KIND_WORDS: Record<string, string> = {
  FEED: 'Feed', WALK: 'Walk', GROOM: 'Grooming', BATH: 'Bath', NAILS: 'Nails', TEETH: 'Teeth', EARS: 'Ears', MEDICATION: 'Medication', FLEA: 'Flea treatment',
  WORM: 'Worming', VACCINATION: 'Vaccination', TANK_CLEAN: 'Tank clean', WATER_TEST: 'Water test', CAGE_CLEAN: 'Cage clean', BEDDING: 'Bedding', FEEDER_REFILL: 'Feeder refill', OTHER: 'Care',
};
/** A suggested schedule per default routine kind: a starting point the person ticks and can change, not advice. */
export const DEFAULT_SCHEDULE: Record<string, { rrule: string; times: string[] }> = {
  WALK: { rrule: 'FREQ=DAILY', times: ['08:00', '18:00'] }, GROOM: { rrule: 'FREQ=WEEKLY', times: [] }, NAILS: { rrule: 'FREQ=MONTHLY', times: [] },
  TEETH: { rrule: 'FREQ=DAILY', times: [] }, FLEA: { rrule: 'FREQ=MONTHLY', times: [] }, WORM: { rrule: 'FREQ=MONTHLY;INTERVAL=3', times: [] },
  VACCINATION: { rrule: 'FREQ=YEARLY', times: [] },
};
const SOURCE_TABLES: Record<string, { table: string; pk: string }> = {
  vaccination: { table: 'health.vaccination', pk: 'vaccination_id' }, treatment: { table: 'health.treatment', pk: 'treatment_id' },
  vet_visit: { table: 'health.vet_visit', pk: 'vet_visit_id' }, medication_event: { table: 'health.medication_event', pk: 'medication_event_id' },
};

export interface RoutineView { id: number; animal_id: number; kind: string; title: string; rrule: string; times: string[]; medication_id: number | null; doses_per_time: string | null; assigned_to: string | null; remind: string; origin: string; source: { table: string; id: number } | null; active_from: string; active_to: string | null; next_due: string | null }
interface RoutineRow { id: number; created_on: string; animal_id: number; kind: string; title: string | null; rrule: string; times: string[]; medication_id: number | null; doses_per_time: string | null; assigned_to: string | null; remind: string; origin: string; source_table: string | null; source_id: number | null; active_from: string; active_to: string | null }
const ROUTINE_SQL = `SELECT routine_id::int AS id, (created_at AT TIME ZONE 'Europe/Dublin')::date::text AS created_on, animal_id::int AS animal_id, kind, title, rrule, times, medication_id::int AS medication_id, doses_per_time::text, assigned_to, remind, origin,
                            source_table, source_id::int AS source_id, active_from::text, active_to::text
                       FROM care.routine WHERE retired_at IS NULL`;
const titleOf = (r: Pick<RoutineRow, 'title' | 'kind'>): string => r.title ?? KIND_WORDS[r.kind] ?? 'Care';

function nextDue(r: RoutineRow, today: string): string | null {
  const rule = parseRule(r.rrule);
  if (!rule) return null;
  const from = r.active_from > today ? r.active_from : today;
  const xs = occurrences(rule, r.active_from, from, addDays(from, 400), 1);
  const d = xs[0] ?? null;
  return d && (!r.active_to || d <= r.active_to) ? d : null;
}
const view = (r: RoutineRow, today: string): RoutineView => ({
  id: r.id, animal_id: r.animal_id, kind: r.kind, title: titleOf(r), rrule: r.rrule, times: r.times, medication_id: r.medication_id, doses_per_time: r.doses_per_time,
  assigned_to: r.assigned_to, remind: r.remind, origin: r.origin, source: r.source_table && r.source_id ? { table: r.source_table, id: r.source_id } : null,
  active_from: r.active_from, active_to: r.active_to, next_due: nextDue(r, today),
});

// ---------------------------------------------------------------- routines

interface NewRoutine { kind: string; title?: string | null; rrule: string; times?: string[]; medication_id?: number | null; doses_per_time?: number | string | null; assigned_to?: string | null; remind?: 'NONE' | 'TODAY'; origin?: string; source_table?: string | null; source_id?: number | null; active_from?: string | null; active_to?: string | null }
const checkRoutine = bodyChecker<NewRoutine>(S.object({
  kind: S.oneOf(ROUTINE_KINDS), title: S.text(80), rrule: { type: 'string', maxLength: 80 },
  times: { type: 'array', maxItems: 12, items: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' } },
  medication_id: S.id(), doses_per_time: S.number(), assigned_to: S.text(80), remind: S.oneOf(['NONE', 'TODAY']), origin: S.oneOf(ORIGINS),
  source_table: { type: ['string', 'null'], enum: [...Object.keys(SOURCE_TABLES), null] }, source_id: S.id(), active_from: S.date(), active_to: S.date(),
}, ['kind', 'rrule']));

export async function addRoutine(c: Client, ws: number, animalId: number, member: string, body: unknown, today = todayIso()): Promise<RoutineView> {
  await requireOn(c, animalId, member, 'MANAGE_CARE');
  const b = checkRoutine(body);
  if (!parseRule(b.rrule)) throw bad('the schedule must be daily, weekly (optionally on given days), monthly or yearly, every n');
  const origin = b.origin ?? (b.kind === 'MEDICATION' ? 'MEDICATION' : 'MANUAL');
  const from = b.active_from ?? today;
  if (b.active_to && b.active_to < from) throw bad('the end date is before the start');
  if (b.kind === 'MEDICATION') {
    if (!b.medication_id) throw bad('a medication routine needs the medicine');
    const ev = await c.query<MedEvent & { id: string; medication_id: string }>(
      `SELECT e.medication_event_id::int AS id, e.medication_id::int AS medication_id, m.product_name, m.strength, e.event_kind, e.event_on::text, e.dose_text, e.dose_amount::text,
              e.dose_unit, e.frequency, e.instructions_verbatim, e.reason, e.status, e.source_class, e.channel
         FROM health.medication_event e JOIN health.medication m ON m.medication_id = e.medication_id WHERE e.medication_id = $1 AND e.animal_id = $2`, [b.medication_id, animalId]);
    if (!ev.rows.length) throw bad('that medicine is not one of this animal\'s');
    if (!deriveCurrent(ev.rows.map((x) => ({ ...x, id: Number(x.id), medication_id: Number(x.medication_id) }))).length) throw conflict('that medicine is not current; start it again first');
  } else if (b.medication_id) throw bad('only a medication routine names a medicine');
  if (origin === 'SPECIES_DEFAULT') {
    const d = await c.query<{ d: string[] }>('SELECT m.default_routines AS d FROM animal.animal a JOIN ref.species_module m ON m.code = a.module_code WHERE a.animal_id = $1', [animalId]);
    if (!(d.rows[0]?.d ?? []).includes(b.kind)) throw bad('that is not one of this species\' suggested routines');
  }
  if (origin === 'VET_ADVICE' && (!b.source_table || !b.source_id)) throw bad('a routine from the vet\'s advice names the record it came from');
  if (!!b.source_table !== !!b.source_id) throw bad('a source names both its kind of record and the record');
  if (b.source_table && b.source_id) {
    // Whatever the origin, a named source must exist and be THIS animal's (independent review, finding 12); the vet's
    // advice must also be confirmed. A record marked "not right" is never a source.
    const src = SOURCE_TABLES[b.source_table]!;
    const ok = await c.query(`SELECT 1 FROM ${src.table} WHERE ${src.pk} = $1 AND animal_id = $2 AND ${origin === 'VET_ADVICE' ? "status = 'CONFIRMED'" : "status <> 'DISPUTED'"}`, [b.source_id, animalId]);
    if (!ok.rowCount) throw bad(origin === 'VET_ADVICE' ? 'that record is not a confirmed record of this animal' : 'that record is not one of this animal\'s');
  }
  const dpt = b.doses_per_time === undefined || b.doses_per_time === null || b.doses_per_time === '' ? null : Number(b.doses_per_time);
  if (dpt !== null && (!Number.isFinite(dpt) || dpt <= 0 || dpt > 100)) throw bad('doses per time must be a positive number');
  const id = await insertRow(c, 'care.routine', 'routine_id', {
    workspace_id: ws, animal_id: animalId, kind: b.kind, title: b.title?.trim() || null, rrule: b.rrule, times: [...new Set(b.times ?? [])].sort(), medication_id: b.medication_id ?? null,
    doses_per_time: dpt, assigned_to: b.assigned_to?.trim() || null, remind: b.remind ?? 'TODAY', origin,
    source_table: b.source_table ?? null, source_id: b.source_table ? b.source_id ?? null : null,
    active_from: from, active_to: b.active_to ?? null, created_by: member,
  });
  return view((await c.query<RoutineRow>(`${ROUTINE_SQL} AND routine_id = $1`, [id])).rows[0]!, today);
}

/** Stop a routine (soft-closed, kept). Its past logs stay. */
export async function retireRoutine(c: Client, animalId: number, rid: number, member: string): Promise<{ id: number; retired: true }> {
  await requireOn(c, animalId, member, 'MANAGE_CARE');
  const r = await c.query('UPDATE care.routine SET retired_at = now(), retired_by = $3 WHERE routine_id = $1 AND animal_id = $2 AND retired_at IS NULL', [rid, animalId, member]);
  if (!r.rowCount) throw notFound('no such routine for this animal');
  return { id: rid, retired: true };
}

// ---------------------------------------------------------------- the care log ("Done")

const checkLog = bodyChecker<{ routine_id?: number | null; due_on?: string | null; due_slot?: string | null; kind?: string | null; amount?: number | string | null; note?: string | null }>(S.object({
  routine_id: S.id(), due_on: S.date(), due_slot: { type: ['string', 'null'], pattern: '^(([01][0-9]|2[0-3]):[0-5][0-9])?$' }, kind: { type: ['string', 'null'], enum: [...ROUTINE_KINDS, null] },
  amount: S.number(), note: S.text(300),
}));

export interface LogResult { logged: boolean; by: string; at: string }
/** One tap: who did it and when. A second tap for the same occurrence changes nothing and says who already did it. */
export async function logCare(c: Client, ws: number, animalId: number, member: string, body: unknown, today = todayIso()): Promise<LogResult> {
  await requireOn(c, animalId, member, 'LOG_CARE');
  const b = checkLog(body);
  const amount = b.amount === undefined || b.amount === null || b.amount === '' ? null : Number(b.amount);
  if (amount !== null && (!Number.isFinite(amount) || amount <= 0 || amount > 100)) throw bad('amount must be a positive number');
  if (!b.routine_id) {
    if (!b.kind) throw bad('say what was done');
    if (b.due_on) throw bad('only a routine has a due date');
    await insertRow(c, 'care.log', 'log_id', { workspace_id: ws, animal_id: animalId, kind: b.kind, done_by: member, amount, note: b.note?.trim() || null });
    return { logged: true, by: member, at: new Date().toISOString() };
  }
  const r = (await c.query<RoutineRow>(`${ROUTINE_SQL} AND routine_id = $1 AND animal_id = $2`, [b.routine_id, animalId])).rows[0];
  if (!r) throw notFound('no such routine for this animal');
  const due = b.due_on ?? today;
  const slot = b.due_slot ?? '';
  const rule = parseRule(r.rrule)!;
  if (due > today) throw bad('that is not due yet');
  if (!occursOn(rule, r.active_from, due)) throw bad('that routine is not due on that day');
  if (slot && !r.times.includes(slot)) throw bad('that routine has no such time');
  if (!slot && r.times.length) throw bad('say which time of day');
  const ins = await c.query<{ at: string }>(
    `INSERT INTO care.log (workspace_id, routine_id, animal_id, kind, due_on, due_slot, done_by, amount, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (workspace_id, routine_id, due_on, due_slot) WHERE routine_id IS NOT NULL AND due_on IS NOT NULL DO NOTHING RETURNING done_at::text AS at`,
    [ws, r.id, animalId, r.kind, due, slot, member, amount ?? (r.doses_per_time !== null ? Number(r.doses_per_time) : null), b.note?.trim() || null]);
  if (ins.rows[0]) return { logged: true, by: member, at: ins.rows[0].at };
  const prev = (await c.query<{ by: string; at: string }>('SELECT done_by AS by, done_at::text AS at FROM care.log WHERE routine_id = $1 AND due_on = $2 AND due_slot = $3', [r.id, due, slot])).rows[0]!;
  return { logged: false, by: prev.by, at: prev.at };
}

// ---------------------------------------------------------------- Today and Coming Up (derived)

export interface AgendaItem {
  key: string;
  animal_id: number;
  animal: string;
  kind: string; // routine kind, or VET_APPOINTMENT / VACCINATION_DUE / TREATMENT_DUE / PRESCRIPTION_RENEWAL
  title: string;
  due_on: string;
  time: string | null;
  overdue: boolean;
  days: number; // from today (negative = overdue)
  detail: string | null;
  routine_id: number | null;
  can_log: boolean;
}

interface LogKey { routine_id: number; due_on: string; due_slot: string }
async function rolesOf(c: Client, member: string): Promise<Map<number, Role>> {
  const r = await c.query<{ a: number; role: Role }>('SELECT animal_id::int AS a, role FROM core.animal_role WHERE member_name = $1 AND to_on IS NULL', [member]);
  return new Map(r.rows.map((x) => [x.a, x.role]));
}

/** Supply left for every current medicine with a quantity on record: pure, for tests. */
export function supplyDaysLeft(quantity: number, given: number, routines: { rule: Rule; slots: number; doses: number }[]): number | null {
  const daily = routines.reduce((s, r) => s + perDay(r.rule) * r.slots * r.doses, 0);
  if (daily <= 0) return null;
  return Math.max(0, (quantity - given) / daily);
}

/** The household's Today and Coming Up (sec 9.3), for one member (every animal is visible; can_log follows their role). */
export async function agenda(c: Client, member: string, today = todayIso(), animalId?: number): Promise<{ today: AgendaItem[]; coming_up: AgendaItem[] }> {
  const horizon = addDays(today, HORIZON_DAYS);
  const animals = new Map((await c.query<{ id: number; name: string }>("SELECT animal_id::int AS id, name FROM animal.animal WHERE status = 'ACTIVE'")).rows.map((a) => [a.id, a.name]));
  const roles = await rolesOf(c, member);
  const canLog = (a: number) => can(effectiveRole(roles.get(a)), 'LOG_CARE');
  const todayList: AgendaItem[] = [];
  const coming: AgendaItem[] = [];
  const item = (a: number, x: Omit<AgendaItem, 'animal_id' | 'animal' | 'overdue' | 'days' | 'can_log'>): AgendaItem => {
    const days = daysBetween(today, x.due_on);
    return { ...x, animal_id: a, animal: animals.get(a)!, overdue: days < 0, days, can_log: x.routine_id !== null && canLog(a) };
  };
  const want = (a: number) => animals.has(a) && (animalId === undefined || animalId === a);

  // confirmed due dates written by the vet win over a routine of the same kind (sec 3.5 "Due dates are derived")
  const recordDue = new Set<string>();
  const vac = await c.query<{ a: number; vaccine: string; due: string }>(
    `SELECT DISTINCT ON (animal_id, lower(vaccine)) animal_id::int AS a, vaccine, next_due_on::text AS due FROM health.vaccination
      WHERE status = 'CONFIRMED' ORDER BY animal_id, lower(vaccine), given_on DESC, vaccination_id DESC`);
  for (const v of vac.rows) {
    if (!want(v.a) || !v.due) continue;
    recordDue.add(`${v.a}|VACCINATION`);
    if (v.due <= horizon) coming.push(item(v.a, { key: `vac-${v.a}-${v.vaccine}`, kind: 'VACCINATION_DUE', title: `${v.vaccine} vaccination`, due_on: v.due, time: null, detail: 'next due date from the vet record', routine_id: null }));
  }
  const tr = await c.query<{ a: number; kind: string; product: string | null; due: string }>(
    `SELECT DISTINCT ON (animal_id, kind) animal_id::int AS a, kind, product, next_due_on::text AS due FROM health.treatment
      WHERE status = 'CONFIRMED' ORDER BY animal_id, kind, given_on DESC, treatment_id DESC`);
  for (const t of tr.rows) {
    if (!want(t.a) || !t.due) continue;
    recordDue.add(`${t.a}|${t.kind}`);
    if (t.due <= horizon) coming.push(item(t.a, { key: `tr-${t.a}-${t.kind}`, kind: 'TREATMENT_DUE', title: KIND_WORDS[t.kind] ?? t.product ?? 'Treatment', due_on: t.due, time: null, detail: t.product, routine_id: null }));
  }

  // routines
  const routines = (await c.query<RoutineRow>(`${ROUTINE_SQL} AND remind = 'TODAY' AND active_from <= $1 AND (active_to IS NULL OR active_to >= $2)`, [horizon, today])).rows.filter((r) => want(r.animal_id));
  const logs = (await c.query<LogKey>(
    `SELECT routine_id::int AS routine_id, due_on::text AS due_on, due_slot FROM care.log WHERE routine_id IS NOT NULL AND due_on >= $1`, [addDays(today, -400)])).rows;
  const done = new Set(logs.map((l) => `${l.routine_id}|${l.due_on}|${l.due_slot}`));
  const doneSince = (rid: number, d: string) => logs.some((l) => l.routine_id === rid && l.due_on >= d);
  for (const r of routines) {
    const rule = parseRule(r.rrule);
    if (!rule) continue;
    if (recordDue.has(`${r.animal_id}|${r.kind}`)) continue;
    const slots = r.times.length ? r.times : [''];
    if (occursOn(rule, r.active_from, today)) {
      for (const s of slots) if (!done.has(`${r.id}|${today}|${s}`)) todayList.push(item(r.animal_id, { key: `r-${r.id}-${today}-${s}`, kind: r.kind, title: titleOf(r), due_on: today, time: s || null, detail: r.assigned_to ? `for ${r.assigned_to}` : null, routine_id: r.id }));
    } else if (rule.freq !== 'DAILY') {
      // a weekly / monthly / yearly task whose last day passed with no log is still owed: it stays in Today, overdue --
      // but only from the day the routine was set up (a start date in the past does not invent a backlog)
      const last = lastOnOrBefore(rule, r.active_from, today);
      if (last && last >= r.created_on && !doneSince(r.id, last)) todayList.push(item(r.animal_id, { key: `r-${r.id}-${last}-`, kind: r.kind, title: titleOf(r), due_on: last, time: slots[0] || null, detail: null, routine_id: r.id }));
    }
    if (rule.freq !== 'DAILY') {
      const next = occurrences(rule, r.active_from, addDays(today, 1), horizon, 1)[0];
      if (next && (!r.active_to || next <= r.active_to)) coming.push(item(r.animal_id, { key: `r-${r.id}-${next}`, kind: r.kind, title: titleOf(r), due_on: next, time: r.times[0] ?? null, detail: null, routine_id: null }));
    }
  }

  // vet appointments
  const ap = await c.query<{ id: number; a: number; on: string; time: string | null; reason: string | null; contact: string | null }>(
    `SELECT p.appointment_id::int AS id, p.animal_id::int AS a, p.starts_on::text AS on, p.starts_time AS time, p.reason, k.name AS contact
       FROM care.appointment p LEFT JOIN core.contact k ON k.contact_id = p.contact_id WHERE p.state = 'BOOKED' AND p.starts_on BETWEEN $1 AND $2 ORDER BY p.starts_on, p.starts_time`, [today, horizon]);
  for (const x of ap.rows) {
    if (!want(x.a)) continue;
    const it = item(x.a, { key: `ap-${x.id}`, kind: 'VET_APPOINTMENT', title: x.reason ? `Vet: ${x.reason}` : 'Vet appointment', due_on: x.on, time: x.time, detail: x.contact, routine_id: null });
    (x.on === today ? todayList : coming).push(it);
  }

  // medication supply (sec 3.5): only medicines with a quantity on record and a medication routine
  for (const s of await supplies(c, today)) {
    if (!want(s.animal_id) || s.days_left === null || s.days_left >= SUPPLY_WARN_DAYS) continue;
    const days = Math.floor(s.days_left);
    coming.push(item(s.animal_id, { key: `sup-${s.medication_id}`, kind: 'PRESCRIPTION_RENEWAL', title: `Prescription renewal approaching: ${s.product_name}`, due_on: addDays(today, days), time: null, detail: `about ${days} day${days === 1 ? '' : 's'} of doses left`, routine_id: null }));
  }

  const order = (a: AgendaItem, b: AgendaItem) => a.due_on.localeCompare(b.due_on) || (a.time ?? '99').localeCompare(b.time ?? '99') || a.animal.localeCompare(b.animal);
  return { today: todayList.sort(order), coming_up: coming.sort(order) };
}

export interface Supply { animal_id: number; medication_id: number; product_name: string; quantity: number; given: number; days_left: number | null }
/** Remaining supply of each current medicine that has a quantity_supplied in its current run. */
export async function supplies(c: Client, today = todayIso()): Promise<Supply[]> {
  const ev = (await c.query<MedEvent & { quantity_supplied: string | null; animal_id: number }>(
    `SELECT e.medication_event_id::int AS id, e.medication_id::int AS medication_id, e.animal_id::int AS animal_id, m.product_name, m.strength, e.event_kind, e.event_on::text AS event_on,
            e.dose_text, e.dose_amount::text, e.dose_unit, e.frequency, e.instructions_verbatim, e.reason, e.status, e.source_class, e.channel, e.quantity_supplied::text
       FROM health.medication_event e JOIN health.medication m ON m.medication_id = e.medication_id
      WHERE e.status = 'CONFIRMED' AND m.retired_at IS NULL ORDER BY e.event_on, e.medication_event_id`)).rows;
  const out: Supply[] = [];
  for (const cur of deriveCurrent(ev)) {
    const run = ev.filter((e) => e.medication_id === cur.medication_id && e.event_on >= cur.since);
    const withQty = [...run].reverse().find((e) => e.quantity_supplied !== null);
    if (!withQty) continue;
    const rs = (await c.query<RoutineRow>(`${ROUTINE_SQL} AND medication_id = $1 AND (active_to IS NULL OR active_to >= $2)`, [cur.medication_id, today])).rows;
    if (!rs.length) continue;
    const given = Number((await c.query<{ n: string }>(
      `SELECT coalesce(sum(coalesce(l.amount, 1)), 0)::text AS n FROM care.log l JOIN care.routine r ON r.routine_id = l.routine_id
        WHERE r.medication_id = $1 AND l.due_on >= $2`, [cur.medication_id, withQty.event_on])).rows[0]!.n);
    const quantity = Number(withQty.quantity_supplied);
    const days_left = supplyDaysLeft(quantity, given, rs.map((r) => ({ rule: parseRule(r.rrule)!, slots: Math.max(1, r.times.length), doses: r.doses_per_time ? Number(r.doses_per_time) : 1 })));
    out.push({ animal_id: withQty.animal_id, medication_id: cur.medication_id, product_name: cur.product_name, quantity, given, days_left });
  }
  return out;
}

/** The Care section of one animal: routines (with next due), suggested defaults not yet set up, recent log, appointments. */
export async function careOf(c: Client, animalId: number, member: string, today = todayIso()) {
  await requireOn(c, animalId, member, 'VIEW');
  const routines = (await c.query<RoutineRow>(`${ROUTINE_SQL} AND animal_id = $1 ORDER BY kind, routine_id`, [animalId])).rows.map((r) => view(r, today));
  const mod = await c.query<{ d: string[] }>('SELECT m.default_routines AS d FROM animal.animal a JOIN ref.species_module m ON m.code = a.module_code WHERE a.animal_id = $1', [animalId]);
  const have = new Set(routines.map((r) => r.kind));
  const suggestions = (mod.rows[0]?.d ?? []).filter((k) => !have.has(k)).map((k) => ({ kind: k, title: KIND_WORDS[k] ?? k, ...(DEFAULT_SCHEDULE[k] ?? { rrule: 'FREQ=WEEKLY', times: [] }) }));
  const log = (await c.query<{ id: number; kind: string; routine_id: number | null; due_on: string | null; due_slot: string; done_at: string; done_by: string; note: string | null }>(
    `SELECT log_id::int AS id, kind, routine_id::int AS routine_id, due_on::text AS due_on, due_slot, done_at::text AS done_at, done_by, note FROM care.log
      WHERE animal_id = $1 ORDER BY done_at DESC LIMIT 30`, [animalId])).rows;
  const appointments = await listAppointments(c, animalId);
  const ag = await agenda(c, member, today, animalId);
  return { routines, suggestions, log, appointments, today: ag.today, coming_up: ag.coming_up, supplies: (await supplies(c, today)).filter((s) => s.animal_id === animalId) };
}

// ---------------------------------------------------------------- vet appointments (+ calendar)

export interface AppointmentView { id: number; animal_id: number; starts_on: string; starts_time: string | null; contact_id: number | null; contact: string | null; reason: string | null; state: string; calendar_state: string | null; calendar_event_id: number | null; calendar_persona: string | null }
const AP_SQL = `SELECT p.appointment_id::int AS id, p.animal_id::int AS animal_id, p.starts_on::text AS starts_on, p.starts_time, p.contact_id::int AS contact_id, k.name AS contact, p.reason, p.state,
                       p.calendar_state, p.calendar_event_id::int AS calendar_event_id, p.calendar_persona
                  FROM care.appointment p LEFT JOIN core.contact k ON k.contact_id = p.contact_id`;
export async function listAppointments(c: Client, animalId: number): Promise<AppointmentView[]> {
  return (await c.query<AppointmentView>(`${AP_SQL} WHERE p.animal_id = $1 AND (p.state = 'BOOKED' OR p.updated_at > now() - interval '30 days') ORDER BY p.starts_on DESC, p.appointment_id DESC LIMIT 20`, [animalId])).rows;
}
export async function getAppointment(c: Client, animalId: number, id: number): Promise<AppointmentView> {
  const r = (await c.query<AppointmentView>(`${AP_SQL} WHERE p.appointment_id = $1 AND p.animal_id = $2`, [id, animalId])).rows[0];
  if (!r) throw notFound('no such appointment for this animal');
  return r;
}

const TIME = { type: ['string', 'null'], pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' };
const checkAppt = bodyChecker<{ starts_on: string; starts_time?: string | null; contact_id?: number | null; reason?: string | null }>(S.object({
  starts_on: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, starts_time: TIME, contact_id: S.id(), reason: S.text(200),
}, ['starts_on']));
const checkMove = bodyChecker<{ starts_on?: string; starts_time?: string | null; contact_id?: number | null; reason?: string | null; state?: 'CANCELLED' }>(S.object({
  starts_on: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, starts_time: TIME, contact_id: S.id(), reason: S.text(200), state: S.oneOf(['CANCELLED']),
}));

async function checkContactId(c: Client, id: number | null | undefined): Promise<void> {
  if (!id) return;
  if (!(await c.query('SELECT 1 FROM core.contact WHERE contact_id = $1 AND retired_at IS NULL', [id])).rowCount) throw bad('that contact is not in this household');
}

/** Book an appointment (Owner / Primary carer). The caller then syncs it to the calendar outside the transaction. */
export async function addAppointment(c: Client, ws: number, animalId: number, member: string, body: unknown, today = todayIso()): Promise<AppointmentView> {
  await requireOn(c, animalId, member, 'MANAGE_CARE');
  const b = checkAppt(body);
  if (b.starts_on < today) throw bad('an appointment is today or later; a past visit is a vet record');
  await checkContactId(c, b.contact_id);
  const id = await insertRow(c, 'care.appointment', 'appointment_id', {
    workspace_id: ws, animal_id: animalId, starts_on: b.starts_on, starts_time: b.starts_time ?? null, contact_id: b.contact_id ?? null, reason: b.reason?.trim() || null, created_by: member, updated_by: member,
  });
  return getAppointment(c, animalId, id);
}

/** Move, change or cancel. The calendar event follows (the caller syncs). */
export async function changeAppointment(c: Client, animalId: number, id: number, member: string, body: unknown, today = todayIso()): Promise<AppointmentView> {
  await requireOn(c, animalId, member, 'MANAGE_CARE');
  const b = checkMove(body);
  const cur = await getAppointment(c, animalId, id);
  if (cur.state === 'CANCELLED') throw conflict('that appointment was cancelled; book a new one');
  if (b.starts_on && b.starts_on < today) throw bad('an appointment is today or later');
  await checkContactId(c, b.contact_id);
  await c.query(
    `UPDATE care.appointment SET starts_on = COALESCE($3::date, starts_on), starts_time = CASE WHEN $4::boolean THEN $5 ELSE starts_time END,
            contact_id = CASE WHEN $6::boolean THEN $7::bigint ELSE contact_id END, reason = CASE WHEN $8::boolean THEN $9 ELSE reason END,
            state = COALESCE($10, state), updated_by = $11, updated_at = now() WHERE appointment_id = $1 AND animal_id = $2`,
    [id, animalId, b.starts_on ?? null, 'starts_time' in b, b.starts_time ?? null, 'contact_id' in b, b.contact_id ?? null, 'reason' in b, b.reason?.trim() || null, b.state ?? null, member]);
  return getAppointment(c, animalId, id);
}

/** Whose calendar: the animal's Primary carer, else an Owner, else whoever acted -- the first with a known persona. */
export async function calendarPersona(c: Client, animalId: number, actor: string, actorPersona?: string): Promise<{ persona: string | undefined; member: string }> {
  const r = await c.query<{ member_name: string; persona_key: string | null }>(
    `SELECT r.member_name, m.persona_key FROM core.animal_role r LEFT JOIN core.member m ON m.member_name = r.member_name
      WHERE r.animal_id = $1 AND r.to_on IS NULL AND r.role IN ('PRIMARY_CARER','OWNER') ORDER BY (r.role = 'PRIMARY_CARER') DESC, r.set_at`, [animalId]);
  for (const x of r.rows) if (x.persona_key) return { persona: x.persona_key, member: x.member_name };
  return { persona: actorPersona, member: actor };
}

/** Remember the member's Synapse persona (verify-device's persona_key), so their calendar can be used. */
export async function rememberMember(c: Client, ws: number, member: string, persona: string | undefined): Promise<void> {
  await c.query(
    `INSERT INTO core.member (workspace_id, member_name, persona_key, created_by) VALUES ($1, $2, $3, $2)
     ON CONFLICT (workspace_id, member_name) DO UPDATE SET persona_key = COALESCE(EXCLUDED.persona_key, core.member.persona_key)`,
    [ws, member, persona ?? null]);
}

/**
 * Make the Synapse calendar match the appointment (add, move or cancel), outside any transaction, then record the result.
 * An event already made stays on the calendar it was put on. Never throws; a failure shows as FAILED with a retry.
 */
export async function syncAppointment(ws: number, animalId: number, id: number, actor: string, actorPersona?: string): Promise<AppointmentView> {
  const pre = await withTxn(ws, true, async (c) => {
    const ap = await getAppointment(c, animalId, id);
    const name = (await c.query<{ name: string }>('SELECT name FROM animal.animal WHERE animal_id = $1', [animalId])).rows[0]!.name;
    let who = await calendarPersona(c, animalId, actor, actorPersona);
    if (ap.calendar_event_id !== null && ap.calendar_persona) {
      const p = (await c.query<{ persona_key: string | null }>('SELECT persona_key FROM core.member WHERE member_name = $1', [ap.calendar_persona])).rows[0]?.persona_key;
      who = { persona: p ?? (ap.calendar_persona === actor ? actorPersona : undefined), member: ap.calendar_persona };
    }
    return { ap, name, who };
  });
  const { ap } = pre;
  const withWhom = ap.contact ? `vet (${ap.contact})` : 'vet';
  const res = await syncVisit(pre.who.persona, {
    id: ap.id, ws, with_whom: ap.reason ? `${withWhom} \u2014 ${ap.reason}` : withWhom, scheduled_on: ap.starts_on, scheduled_time: ap.starts_time, reason: ap.reason, calendar_event_id: ap.calendar_event_id,
  }, pre.name, false, ap.state === 'CANCELLED');
  if (!res) return ap;
  return withTxn(ws, false, async (c) => {
    await c.query('UPDATE care.appointment SET calendar_event_id = $3, calendar_state = $4, calendar_persona = $5 WHERE appointment_id = $1 AND animal_id = $2',
      [id, animalId, res.event_id, res.state, res.event_id === null && res.state === null ? null : pre.who.member]);
    return getAppointment(c, animalId, id);
  });
}

export { toId };
