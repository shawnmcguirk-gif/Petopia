// Vet records entered by hand (spec sec 3.5, 4.3, 7.2; S4, A17): vet visits, vaccinations, treatments, conditions,
// allergies, procedures, lab results. One registry describes each kind's fields, so every kind gets the same rules:
//   - ajv-checked body (unknown fields refused), dates a person may half-remember stored with their precision;
//   - Owner / Primary carer: the row is CONFIRMED by them. Family member: the row is PROPOSED and waits for an Owner /
//     Primary carer to confirm it (sec 7.2 "can propose"). Viewer: refused;
//   - never edited in place: "correct" inserts a new row that supersedes the old (sec 4.3 step 5); "not right" marks
//     it DISPUTED (hidden, kept). The database enforces the same (provenance + append-only guards);
//   - the vet's words are stored as typed (diagnosis_text, value_printed): Petopia never writes or infers a diagnosis.
import { can, requireOn, type Role } from './access.js';
import { parseVagueDate, todayIso, formatVagueDate, type Precision } from './age.js';
import type { Client } from './db.js';
import { bad, conflict, notFound } from './errors.js';
import { badgeFor, insertRow, manualProvenance, MANUAL_SOURCES, type Badge, type ManualSource } from './provenance.js';
import { Decimal } from 'decimal.js';
import { S, bodyChecker, type Schema } from './validate.js';

type Field =
  | { t: 'text'; max: number }
  | { t: 'vdate'; precision: string } // vague date + its precision column
  | { t: 'date'; after?: string } // an exact date (next due, follow-up)
  | { t: 'enum'; values: readonly string[]; dflt?: string }
  | { t: 'money' } // cost_amount (+ cost_currency, EUR by default)
  | { t: 'contact' }
  | { t: 'visit' };

export interface KindDef { table: string; pk: string; label: string; date: string; fields: Record<string, Field>; required: string[] }

const T = (max = 300): Field => ({ t: 'text', max });
const L: Field = { t: 'text', max: 4000 };

export const KINDS = {
  vet_visit: {
    table: 'health.vet_visit', pk: 'vet_visit_id', label: 'Vet visit', date: 'visit_on',
    fields: {
      visit_on: { t: 'vdate', precision: 'visit_precision' },
      kind: { t: 'enum', values: ['ROUTINE', 'ILLNESS', 'EMERGENCY', 'SURGERY', 'REFERRAL', 'FOLLOW_UP'], dflt: 'ROUTINE' },
      contact_id: { t: 'contact' }, vet_name: T(120), reason: T(300), symptoms: L, examination: L, diagnosis_text: L, treatment_text: L,
      follow_up_on: { t: 'date', after: 'visit_on' }, cost_amount: { t: 'money' }, notes: L,
    },
    required: ['visit_on'],
  },
  vaccination: {
    table: 'health.vaccination', pk: 'vaccination_id', label: 'Vaccination', date: 'given_on',
    fields: { vaccine: T(120), given_on: { t: 'vdate', precision: 'given_precision' }, next_due_on: { t: 'date', after: 'given_on' }, batch: T(60), vet_visit_id: { t: 'visit' }, notes: L },
    required: ['vaccine', 'given_on'],
  },
  treatment: {
    table: 'health.treatment', pk: 'treatment_id', label: 'Treatment', date: 'given_on',
    fields: {
      kind: { t: 'enum', values: ['FLEA', 'WORM', 'TICK', 'DENTAL', 'OTHER'] }, product: T(120), given_on: { t: 'vdate', precision: 'given_precision' },
      next_due_on: { t: 'date', after: 'given_on' }, vet_visit_id: { t: 'visit' }, notes: L,
    },
    required: ['kind', 'given_on'],
  },
  condition: {
    table: 'health.condition', pk: 'condition_id', label: 'Condition', date: 'first_noted_on',
    fields: {
      name: T(160), condition_status: { t: 'enum', values: ['SUSPECTED', 'ACTIVE', 'RESOLVED'], dflt: 'ACTIVE' },
      first_noted_on: { t: 'vdate', precision: 'first_noted_precision' }, vet_visit_id: { t: 'visit' }, notes: L,
    },
    required: ['name'],
  },
  allergy: {
    table: 'health.allergy', pk: 'allergy_id', label: 'Allergy', date: 'noted_on',
    fields: {
      substance: T(160), substance_kind: { t: 'enum', values: ['FOOD', 'DRUG', 'ENVIRONMENT', 'OTHER'], dflt: 'OTHER' }, reaction: T(300),
      certainty: { t: 'enum', values: ['CONFIRMED_BY_VET', 'SUSPECTED'], dflt: 'SUSPECTED' }, noted_on: { t: 'vdate', precision: 'noted_precision' }, notes: L,
    },
    required: ['substance'],
  },
  procedure: {
    table: 'health.procedure', pk: 'procedure_id', label: 'Procedure', date: 'performed_on',
    fields: { name: T(160), performed_on: { t: 'vdate', precision: 'performed_precision' }, vet_visit_id: { t: 'visit' }, outcome: T(500), notes: L },
    required: ['name', 'performed_on'],
  },
  lab_result: {
    table: 'health.lab_result', pk: 'lab_result_id', label: 'Lab result', date: 'sampled_on',
    fields: {
      test: T(160), analyte: T(120), value_printed: T(60), unit_printed: T(30), ref_range_printed: T(60), flag_printed: T(20),
      sampled_on: { t: 'vdate', precision: 'sampled_precision' }, vet_visit_id: { t: 'visit' }, notes: L,
    },
    required: ['test', 'sampled_on'],
  },
} as const satisfies Record<string, KindDef>;
export type Kind = keyof typeof KINDS;
export const KIND_CODES = Object.keys(KINDS) as Kind[];
export const isKind = (v: unknown): v is Kind => typeof v === 'string' && v in KINDS;

// ---- JSON Schemas, built from the registry ----
function fieldSchema(f: Field): Schema {
  switch (f.t) {
    case 'text': return S.text(f.max);
    case 'vdate': return S.vagueDate();
    case 'date': return S.date();
    case 'enum': return S.oneOf(f.values);
    case 'money': return S.number();
    case 'contact': case 'visit': return S.id();
  }
}
const checkers = new Map<Kind, (b: unknown) => Record<string, unknown>>();
export function schemaFor(kind: Kind): Schema {
  const d: KindDef = KINDS[kind];
  const props: Record<string, Schema> = { source: S.oneOf(MANUAL_SOURCES) };
  for (const [k, f] of Object.entries(d.fields)) props[k] = fieldSchema(f);
  if ('cost_amount' in d.fields) props.cost_currency = { type: ['string', 'null'], pattern: '^[A-Z]{3}$' };
  return S.object(props, d.required);
}
function check(kind: Kind, body: unknown): Record<string, unknown> {
  let f = checkers.get(kind);
  if (!f) { f = bodyChecker<Record<string, unknown>>(schemaFor(kind)); checkers.set(kind, f); }
  return f(body);
}

// ---- shared helpers (also used by medications.ts) ----
/** A vague date ("2025", "2025-10", "2025-10-03"), not in the future. Empty -> today (DAY). */
export function vagueOrToday(v: unknown, field: string, today = todayIso()): { on: string; precision: Exclude<Precision, 'UNKNOWN'> } {
  if (v === undefined || v === null || v === '') return { on: today, precision: 'DAY' };
  const p = parseVagueDate(v);
  if (!p) throw bad(`${field} must be a year (2025), a month (2025-10) or a date (2025-10-03)`);
  if (p.on > today) throw bad(`${field} cannot be in the future`);
  return p;
}
export async function checkContact(c: Client, id: number | null): Promise<void> {
  if (id === null) return;
  if (!(await c.query('SELECT 1 FROM core.contact WHERE contact_id = $1 AND retired_at IS NULL', [id])).rowCount) throw bad('that contact is not in this household');
}
/** A linked vet visit must be this animal's (and not one marked "not right"). */
export async function checkVisit(c: Client, animalId: number, id: number | null): Promise<void> {
  if (id === null) return;
  const r = await c.query("SELECT 1 FROM health.vet_visit WHERE vet_visit_id = $1 AND animal_id = $2 AND status IN ('CONFIRMED','PROPOSED')", [id, animalId]);
  if (!r.rowCount) throw bad('that vet visit is not one of this animal\'s');
}

/** Body -> column values, with every rule of the registry applied. Also used by the inbox when it files a document. */
export async function recordColumns(c: Client, kind: Kind, animalId: number, body: unknown, today: string): Promise<{ cols: Record<string, unknown>; source: ManualSource }> {
  const d: KindDef = KINDS[kind];
  const b = check(kind, body);
  const cols: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(d.fields)) {
    const v = b[k];
    const empty = v === undefined || v === null || v === '';
    switch (f.t) {
      case 'text': {
        const s = typeof v === 'string' ? v.trim() : '';
        if (!s && d.required.includes(k)) throw bad(`${k.replace(/_/g, ' ')} is required`);
        cols[k] = s || null;
        break;
      }
      case 'vdate': {
        if (empty) {
          if (d.required.includes(k)) throw bad(`${k.replace(/_/g, ' ')} is required`);
          cols[k] = null; cols[f.precision] = null;
          break;
        }
        const p = vagueOrToday(v, k, today);
        cols[k] = p.on; cols[f.precision] = p.precision;
        break;
      }
      case 'date': {
        if (empty) { cols[k] = null; break; }
        const p = parseVagueDate(v);
        if (!p || p.precision !== 'DAY') throw bad(`${k.replace(/_/g, ' ')} must be a date (2026-10-03)`);
        if (f.after && cols[f.after] && p.on <= (cols[f.after] as string)) throw bad(`${k.replace(/_/g, ' ')} must be after ${f.after.replace(/_/g, ' ')}`);
        cols[k] = p.on;
        break;
      }
      case 'enum': cols[k] = empty ? (f.dflt ?? null) : v; break;
      case 'money': {
        if (empty) { cols[k] = null; cols.cost_currency = null; break; }
        let amount: Decimal;
        try { amount = new Decimal(typeof v === 'string' ? v.trim().replace(',', '.') : (v as number)); } catch { throw bad('cost must be a number'); }
        if (!amount.isFinite() || amount.isNegative() || amount.decimalPlaces() > 2) throw bad('cost must be an amount like 65.50');
        cols[k] = amount.toFixed(2);
        cols.cost_currency = typeof b.cost_currency === 'string' ? b.cost_currency : 'EUR';
        break;
      }
      case 'contact': await checkContact(c, empty ? null : (v as number)); cols[k] = empty ? null : v; break;
      case 'visit': await checkVisit(c, animalId, empty ? null : (v as number)); cols[k] = empty ? null : v; break;
    }
  }
  return { cols, source: (b.source as ManualSource | undefined) ?? 'OWNER_OBSERVATION' };
}

export interface RecordView { id: number; kind: Kind; status: string; badge: Badge; by: string; confirmed_by: string | null; supersedes_id: number | null; created_at: string; fields: Record<string, unknown> }

/** The kind's rows for one animal (confirmed and waiting; superseded / disputed hidden), newest first. */
export async function listRecords(c: Client, kind: Kind, animalId: number): Promise<RecordView[]> {
  const d: KindDef = KINDS[kind];
  const r = await c.query<Record<string, unknown>>(
    `SELECT * FROM ${d.table} WHERE animal_id = $1 AND status IN ('CONFIRMED','PROPOSED')
      ORDER BY ${d.date} DESC NULLS LAST, ${d.pk} DESC`,
    [animalId],
  );
  return r.rows.map((row) => toView(kind, row));
}

function toView(kind: Kind, row: Record<string, unknown>): RecordView {
  const d: KindDef = KINDS[kind];
  const fields: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(d.fields)) {
    const v = row[k];
    if (f.t === 'vdate') { fields[k] = formatVagueDate((v as string | null) ?? null, ((row[f.precision] as Precision | null) ?? 'UNKNOWN')); fields[f.precision] = row[f.precision] ?? null; }
    else if (f.t === 'contact' || f.t === 'visit') fields[k] = v === null ? null : Number(v);
    else if (f.t === 'money') { fields[k] = v; fields.cost_currency = row.cost_currency; }
    else fields[k] = v;
  }
  return {
    id: Number(row[d.pk]), kind, status: row.status as string, badge: badgeFor(row as { source_class: string; status: string; channel: string }),
    by: (row.proposed_by as string), confirmed_by: (row.confirmed_by as string | null), supersedes_id: row.supersedes_id === null ? null : Number(row.supersedes_id),
    created_at: (row.created_at as Date).toISOString(), fields,
  };
}

async function rowOf(c: Client, kind: Kind, animalId: number, id: number, lock = true): Promise<Record<string, unknown>> {
  const d: KindDef = KINDS[kind];
  const r = await c.query<Record<string, unknown>>(`SELECT * FROM ${d.table} WHERE ${d.pk} = $1 AND animal_id = $2${lock ? ' FOR UPDATE' : ''}`, [id, animalId]);
  if (!r.rows[0]) throw notFound(`no such ${d.label.toLowerCase()} for this animal`);
  return r.rows[0];
}

async function setStatus(c: Client, kind: Kind, id: number, status: 'CONFIRMED' | 'SUPERSEDED' | 'DISPUTED', member: string): Promise<void> {
  const d: KindDef = KINDS[kind];
  if (status === 'CONFIRMED') await c.query(`UPDATE ${d.table} SET status = 'CONFIRMED', confirmed_by = $2, confirmed_at = now() WHERE ${d.pk} = $1`, [id, member]);
  else await c.query(`UPDATE ${d.table} SET status = $2 WHERE ${d.pk} = $1`, [id, status]);
}

/** Add a record. Owner / Primary carer: confirmed by them. Family member: a proposal. Viewer: 403. */
export async function addRecord(c: Client, ws: number, kind: Kind, animalId: number, member: string, body: unknown, today = todayIso(), supersedes: number | null = null): Promise<RecordView> {
  const role: Role = await requireOn(c, animalId, member, 'PROPOSE_RECORDS');
  const { cols, source } = await recordColumns(c, kind, animalId, body, today);
  const confirm = can(role, 'CONFIRM_RECORDS');
  const d: KindDef = KINDS[kind];
  const id = await insertRow(c, d.table, d.pk, {
    workspace_id: ws, animal_id: animalId, ...cols, created_by: member, supersedes_id: supersedes, ...manualProvenance(member, source, confirm),
  });
  if (confirm && supersedes !== null) await setStatus(c, kind, supersedes, 'SUPERSEDED', member);
  return toView(kind, await rowOf(c, kind, animalId, id, false));
}

/** Correct a record (sec 4.3): a new row with the full corrected values supersedes the old one. A Family member's
 *  correction is a proposal; the old row stays as it is until an Owner / Primary carer confirms the correction. */
export async function correctRecord(c: Client, ws: number, kind: Kind, animalId: number, id: number, member: string, body: unknown, today = todayIso()): Promise<RecordView> {
  await requireOn(c, animalId, member, 'PROPOSE_RECORDS');
  const old = await rowOf(c, kind, animalId, id);
  if (old.status !== 'CONFIRMED' && old.status !== 'PROPOSED') throw conflict('only a current record can be corrected');
  return addRecord(c, ws, kind, animalId, member, body, today, id);
}

/** Owner / Primary carer confirms a proposal. If it corrects an earlier row, that row becomes SUPERSEDED. */
export async function confirmRecord(c: Client, kind: Kind, animalId: number, id: number, member: string): Promise<RecordView> {
  await requireOn(c, animalId, member, 'CONFIRM_RECORDS');
  const row = await rowOf(c, kind, animalId, id);
  if (row.status !== 'PROPOSED') throw conflict('only a record waiting to be checked can be confirmed');
  if (row.source_class === 'AI_SUGGESTION') throw conflict('an AI suggestion is never confirmed as it stands; add it as your own note instead');
  await setStatus(c, kind, id, 'CONFIRMED', member);
  if (row.supersedes_id !== null) {
    const old = await rowOf(c, kind, animalId, Number(row.supersedes_id));
    if (old.status === 'CONFIRMED' || old.status === 'PROPOSED' || old.status === 'DISPUTED') await setStatus(c, kind, Number(row.supersedes_id), 'SUPERSEDED', member);
  }
  return toView(kind, await rowOf(c, kind, animalId, id, false));
}

/** "Not right" (sec 4.3 step 4): DISPUTED -- hidden from views, kept for the record. Owner / Primary carer only. */
export async function disputeRecord(c: Client, kind: Kind, animalId: number, id: number, member: string): Promise<{ id: number; status: string }> {
  await requireOn(c, animalId, member, 'CONFIRM_RECORDS');
  const row = await rowOf(c, kind, animalId, id);
  if (row.status !== 'PROPOSED' && row.status !== 'CONFIRMED') throw conflict('that record is already set aside');
  await setStatus(c, kind, id, 'DISPUTED', member);
  return { id, status: 'DISPUTED' };
}
