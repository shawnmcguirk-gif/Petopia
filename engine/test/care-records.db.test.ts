// S3 + S4 rules that need Postgres (A15-A19, sec 4.2, 7.2) and the review fixes that touch the database. Runs only
// with PETOPIA_TEST_DATABASE_URL (the petopia_test database, never the live one). Fictional fixtures only: "Biscuit",
// a cat. Every run makes its own households.
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL_ = process.env.PETOPIA_TEST_DATABASE_URL;
if (URL_) process.env.PETOPIA_DATABASE_URL = URL_;

const { grantHousehold, setAnimalRole } = await import('../src/access.js');
const { createAnimal, getAnimal, listAnimals, updateAnimal } = await import('../src/animals.js');
const { addContact, listContacts } = await import('../src/contacts.js');
const { closePool, withTxn } = await import('../src/db.js');
const { getFeeding, setFeeding } = await import('../src/feeding.js');
const { getHealth } = await import('../src/health.js');
const { addMeasurement, listMeasurements } = await import('../src/measurements.js');
const { MEASURES } = await import('../src/measures.js');
const { addMedication, addMedicationEvent } = await import('../src/medications.js');
const { addRecord, confirmRecord, correctRecord, disputeRecord, listRecords } = await import('../src/records.js');
const { getTimeline } = await import('../src/timeline.js');

const run = `c${Date.now().toString(36)}`;
const who = (n: string) => `${run}-${n}`;
const T = '2026-10-07';
const NEW_TABLES = ['health.measurement', 'diet.feeding_plan', 'health.vet_visit', 'health.vaccination', 'health.treatment', 'health.condition',
  'health.allergy', 'health.procedure', 'health.lab_result', 'health.medication', 'health.medication_event'];
const FACT_TABLES = NEW_TABLES.filter((t) => t !== 'health.medication');

async function newHousehold(member: string): Promise<number> {
  return withTxn(null, false, async (c) => {
    const id = Number((await c.query<{ id: string }>("SELECT nextval(pg_get_serial_sequence('core.workspace','workspace_id'))::text AS id")).rows[0]!.id);
    await c.query("SELECT set_config('app.current_workspace_id', $1, true)", [String(id)]);
    await c.query("INSERT INTO core.workspace (workspace_id, display_name, created_by) VALUES ($1, $2, 'test')", [id, `${run} household`]);
    await c.query("INSERT INTO core.habitat (workspace_id, name, kind, created_by) VALUES ($1, 'Home', 'HOME', 'test')", [id]);
    await c.query("INSERT INTO core.access_grant (workspace_id, member_name, granted_by) VALUES ($1, $2, 'test')", [id, member]);
    return id;
  });
}
const biscuit = { name: 'Biscuit', species: 'cat', breed: 'Domestic shorthair', born: '2018' };

describe.skipIf(!URL_)('S3 + S4 database rules', () => {
  let A = 0;
  let B = 0;
  let cat = 0; // Biscuit in household A: alex Owner, sam Family (default), kim Viewer
  const alex = who('alex');
  const sam = who('sam');
  const kim = who('kim');
  const blair = who('blair');
  beforeAll(async () => {
    A = await newHousehold(alex);
    B = await newHousehold(blair);
    await withTxn(A, false, async (c) => {
      await grantHousehold(c, A, sam, alex, [alex]);
      await grantHousehold(c, A, kim, alex, [alex]);
    });
    cat = (await withTxn(A, false, (c) => createAnimal(c, A, alex, biscuit, T))).id;
    await withTxn(A, false, (c) => setAnimalRole(c, A, cat, kim, 'VIEWER', alex));
  });
  afterAll(async () => closePool());
  const inA = <X,>(fn: (c: import('../src/db.js').Client) => Promise<X>) => withTxn(A, false, fn);

  it('A3: every new table has FORCE RLS; the timeline view shows nothing to another or an unset household', async () => {
    const r = await withTxn(null, true, (c) => c.query<{ t: string; ok: boolean }>(
      `SELECT n.nspname || '.' || c.relname AS t, c.relrowsecurity AND c.relforcerowsecurity AS ok
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname IN ('health','diet')`));
    expect(r.rows.filter((x) => !x.ok).map((x) => x.t)).toEqual([]);
    expect(r.rows.map((x) => x.t)).toEqual(expect.arrayContaining(NEW_TABLES));
    await inA((c) => addMeasurement(c, A, cat, alex, { measure: 'weight', value: 4.2, unit: 'kg', on: '2026-09-01' }, T));
    await inA((c) => addRecord(c, A, 'vaccination', cat, alex, { vaccine: 'Cat flu', given_on: '2025-10-02' }, T));
    const unset = await withTxn(null, true, (c) => c.query<{ n: string }>(
      `SELECT (SELECT count(*) FROM timeline.entry_v) + ${NEW_TABLES.map((t) => `(SELECT count(*) FROM ${t})`).join(' + ')} AS n`));
    expect(unset.rows[0]!.n).toBe('0');
    const fromB = await withTxn(B, true, (c) => c.query<{ n: string }>('SELECT count(*)::text AS n FROM timeline.entry_v WHERE animal_id = $1', [cat]));
    expect(fromB.rows[0]!.n).toBe('0');
    await expect(withTxn(B, true, (c) => getTimeline(c, cat, blair))).rejects.toMatchObject({ status: 404 });
    await expect(withTxn(A, false, (c) => c.query(
      `INSERT INTO health.measurement (workspace_id, animal_id, measure, value, unit, value_as_entered, unit_as_entered, observed_at, status, source_class, channel, extraction_method, proposed_by, created_by)
       VALUES ($1, $2, 'weight', 1, 'kg', '1', 'kg', now(), 'PROPOSED', 'OWNER_OBSERVATION', 'MANUAL', 'MANUAL', 'x', 'x')`, [B, cat]))).rejects.toMatchObject({ code: '42501' });
  });

  it('A4 on the new fact tables: provenance block present; LLM_PROPOSAL / AI_SUGGESTION never inserted CONFIRMED', async () => {
    const cons = await withTxn(null, true, (c) => c.query<{ t: string; n: string }>(
      `SELECT conrelid::regclass::text AS t, count(*)::text AS n FROM pg_constraint WHERE conname LIKE '%\\_pv\\_%' GROUP BY 1`));
    for (const t of FACT_TABLES) expect(cons.rows.find((x) => x.t === t)?.n, t).toBe('7');
    const base = `INSERT INTO health.vaccination (workspace_id, animal_id, vaccine, given_on, status, source_class, channel, extraction_method, proposed_by, confirmed_by, confirmed_at, created_by)`;
    await expect(inA((c) => c.query(`${base} VALUES ($1, $2, 'x', '2025-01-01', 'CONFIRMED', 'VET_RECORD', 'MANUAL', 'LLM_PROPOSAL', 'petopia-reader', 'Alex', now(), 'x')`, [A, cat]))).rejects.toMatchObject({ code: '23514' });
    await expect(inA((c) => c.query(`${base} VALUES ($1, $2, 'x', '2025-01-01', 'CONFIRMED', 'AI_SUGGESTION', 'MANUAL', 'MANUAL', 'Alex', 'Alex', now(), 'x')`, [A, cat]))).rejects.toMatchObject({ code: '23514' });
    await expect(inA((c) => c.query(`${base} VALUES ($1, $2, 'x', '2025-01-01', 'CONFIRMED', 'VET_RECORD', 'MANUAL', 'MANUAL', 'Alex', NULL, NULL, 'x')`, [A, cat]))).rejects.toMatchObject({ code: '23514' });
  });

  it('facts are append-only in the database: no DELETE, no edit in place (only the status flow)', async () => {
    const v = await inA((c) => addRecord(c, A, 'vaccination', cat, alex, { vaccine: 'Rabies', given_on: '2025-03-01' }, T));
    await expect(inA((c) => c.query("UPDATE health.vaccination SET vaccine = 'Changed' WHERE vaccination_id = $1", [v.id]))).rejects.toMatchObject({ code: '23514' });
    await expect(inA((c) => c.query('DELETE FROM health.vaccination WHERE vaccination_id = $1', [v.id]))).rejects.toMatchObject({ code: '23514' });
    const w = await withTxn(A, true, (c) => listMeasurements(c, cat, alex, 'weight'));
    await expect(inA((c) => c.query('UPDATE health.measurement SET value = 9 WHERE measurement_id = $1', [w[0]!.id]))).rejects.toMatchObject({ code: '23514' });
  });

  describe('S3 weight (A16)', () => {
    let dog = 0;
    beforeAll(async () => { dog = (await inA((c) => createAnimal(c, A, alex, { name: 'Biscuit Two', species: 'dog' }, T))).id; });

    it('6.1 kg -> the card shows 6.1 kg; it is an "Our note" confirmed by the person', async () => {
      await inA((c) => addMeasurement(c, A, dog, alex, { measure: 'weight', value: 6.1, unit: 'kg', on: '2026-10-01' }, T));
      const a = await withTxn(A, true, (c) => getAnimal(c, dog, alex, T));
      expect(a.latest_weight).toEqual({ kg: '6.1', on: '2026-10-01', change_kg: null });
      const row = await withTxn(A, true, (c) => c.query("SELECT status, source_class, channel, confirmed_by FROM health.measurement WHERE animal_id = $1", [dog]));
      expect(row.rows[0]).toEqual({ status: 'CONFIRMED', source_class: 'OWNER_OBSERVATION', channel: 'MANUAL', confirmed_by: alex });
    });
    it('61 kg asks "did you mean 6.1?" and saves nothing; saved only on an explicit yes, which is recorded', async () => {
      await expect(inA((c) => addMeasurement(c, A, dog, alex, { measure: 'weight', value: 61, unit: 'kg', on: '2026-10-05' }, T)))
        .rejects.toMatchObject({ status: 409, extra: { needs_confirmation: true, suggestion: { value: '6.1', unit: 'kg' } } });
      expect(await withTxn(A, true, (c) => listMeasurements(c, dog, alex, 'weight'))).toHaveLength(1);
      const after = await inA((c) => addMeasurement(c, A, dog, alex, { measure: 'weight', value: 61, unit: 'kg', on: '2026-10-05', confirm_unusual: true }, T));
      expect(after.at(-1)).toMatchObject({ value: '61', unusual_confirmed: true, change: '+54.9' });
    });
    it('lb is converted to kg; change since last; a Family member may weigh, a Viewer may not', async () => {
      const list = await inA((c) => addMeasurement(c, A, cat, sam, { measure: 'weight', value: '9.5', unit: 'lb', on: '2026-10-06' }, T));
      expect(list.at(-1)).toMatchObject({ value: '4.309', unit: 'kg', value_as_entered: '9.5', unit_as_entered: 'lb', change: '+0.109', by: sam });
      await expect(inA((c) => addMeasurement(c, A, cat, kim, { measure: 'weight', value: 4.3, unit: 'kg' }, T))).rejects.toMatchObject({ status: 403 });
      await expect(inA((c) => addMeasurement(c, A, cat, alex, { measure: 'weight', value: 4.3, unit: 'kg', on: '2026-12-01' }, T))).rejects.toMatchObject({ status: 400 });
      await expect(inA((c) => addMeasurement(c, A, cat, alex, { measure: 'weight', value: 4.3, unit: 'kg', colour: 'x' }, T))).rejects.toMatchObject({ status: 400 });
    });
    it('the measure registry in the database matches engine/src/measures.ts', async () => {
      const r = await withTxn(null, true, (c) => c.query<{ code: string; accepted_units: string[]; stored: string[] }>(
        'SELECT m.code, m.accepted_units, array_agg(u.unit ORDER BY u.unit) AS stored FROM ref.measure m JOIN ref.measure_unit u ON u.measure = m.code GROUP BY 1, 2'));
      for (const row of r.rows) {
        const m = MEASURES[row.code as keyof typeof MEASURES];
        expect(m, row.code).toBeTruthy();
        expect([...row.accepted_units].sort()).toEqual(Object.keys(m.units).sort());
        expect(row.stored).toEqual(m.stored ? [m.stored] : Object.keys(m.units).sort());
      }
      expect(r.rows).toHaveLength(Object.keys(MEASURES).length);
    });
  });

  describe('S3 feeding (A15)', () => {
    it('changing the food closes the old row with an end date; nothing is overwritten', async () => {
      await inA((c) => setFeeding(c, A, cat, alex, { brand: 'Acme', product: 'Indoor adult', food_type: 'DRY', portion_amount: 60, portion_unit: 'g', times: ['8:00', '18:00'], from_on: '2026-06-01' }, T));
      let f = await withTxn(A, true, (c) => getFeeding(c, cat, sam));
      expect(f.current).toMatchObject({ brand: 'Acme', portion_amount: '60', times: ['08:00', '18:00'], to_on: null, badge: { text: 'Our note' } });
      f = await inA((c) => setFeeding(c, A, cat, alex, { brand: 'Acme', product: 'Senior', food_type: 'WET', from_on: '2026-10-01' }, T));
      expect(f.current).toMatchObject({ product: 'Senior', from_on: '2026-10-01', to_on: null });
      expect(f.history).toMatchObject([{ product: 'Indoor adult', from_on: '2026-06-01', to_on: '2026-10-01' }]);
      const a = await withTxn(A, true, (c) => getAnimal(c, cat, alex, T));
      expect(a.current_food).toMatchObject({ product: 'Senior', food_type: 'WET' });
    });
    it('rules: Owner / Primary carer only; cannot start before the current food; DB refuses rewriting history', async () => {
      await expect(inA((c) => setFeeding(c, A, cat, sam, { brand: 'X', food_type: 'DRY' }, T))).rejects.toMatchObject({ status: 403 });
      await expect(inA((c) => setFeeding(c, A, cat, alex, { brand: 'X', food_type: 'DRY', from_on: '2026-09-01' }, T))).rejects.toMatchObject({ status: 400 });
      await expect(inA((c) => setFeeding(c, A, cat, alex, { food_type: 'DRY' }, T))).rejects.toMatchObject({ status: 400 });
      const old = (await withTxn(A, true, (c) => getFeeding(c, cat, alex))).history[0]!;
      await expect(inA((c) => c.query("UPDATE diet.feeding_plan SET to_on = '2026-09-15' WHERE feeding_plan_id = $1", [old.id]))).rejects.toMatchObject({ code: '23514' });
      await expect(inA((c) => c.query("UPDATE diet.feeding_plan SET brand = 'Other' WHERE feeding_plan_id = $1", [old.id]))).rejects.toMatchObject({ code: '23514' });
      await expect(inA((c) => c.query('DELETE FROM diet.feeding_plan WHERE feeding_plan_id = $1', [old.id]))).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('S4 vet records (A17, A19)', () => {
    it('S4 acceptance: last year\'s vaccination with next-due date appears on the Timeline with its badge', async () => {
      const v = await inA((c) => addRecord(c, A, 'vaccination', cat, alex, { vaccine: 'Feline enteritis', given_on: '2025-10-03', next_due_on: '2026-10-03', source: 'VET_RECORD' }, T));
      expect(v).toMatchObject({ status: 'CONFIRMED', badge: { text: 'Vet record' }, fields: { next_due_on: '2026-10-03' } });
      const tl = await withTxn(A, true, (c) => getTimeline(c, cat, kim)); // a Viewer may look
      expect(tl.find((e) => e.ref.table === 'vaccination' && e.ref.id === v.id)).toMatchObject({ label: 'Vaccination', title: 'Feline enteritis', on: '2025-10-03', badge: { text: 'Vet record' } });
      expect(tl.some((e) => e.badge.text === 'Our note')).toBe(true);
      expect(tl.map((e) => e.sort_on)).toEqual([...tl.map((e) => e.sort_on)].sort().reverse());
      const weights = await withTxn(A, true, (c) => getTimeline(c, cat, alex, 'WEIGHT'));
      expect(weights.length).toBeGreaterThan(0);
      expect(weights.every((e) => e.category === 'WEIGHT')).toBe(true);
    });
    it('a Family member\'s entry is a proposal; they cannot confirm it; an Owner can; a Viewer cannot write', async () => {
      const p = await inA((c) => addRecord(c, A, 'condition', cat, sam, { name: 'Itchy ears', condition_status: 'SUSPECTED' }, T));
      expect(p).toMatchObject({ status: 'PROPOSED', badge: { code: 'WAITING' }, confirmed_by: null });
      await expect(inA((c) => confirmRecord(c, 'condition', cat, p.id, sam))).rejects.toMatchObject({ status: 403 });
      await expect(inA((c) => addRecord(c, A, 'condition', cat, kim, { name: 'x' }, T))).rejects.toMatchObject({ status: 403 });
      const ok = await inA((c) => confirmRecord(c, 'condition', cat, p.id, alex));
      expect(ok).toMatchObject({ status: 'CONFIRMED', confirmed_by: alex, badge: { text: 'Our note' } });
    });
    it('correct: a new row supersedes the old (Family: only once confirmed); "not right" hides a row but keeps it', async () => {
      const v = await inA((c) => addRecord(c, A, 'vet_visit', cat, alex, { visit_on: '2026-09-10', reason: 'Check-up', cost_amount: '65.5', vet_name: 'Dr Example' }, T));
      expect(v.fields).toMatchObject({ cost_amount: '65.50', cost_currency: 'EUR', kind: 'ROUTINE' });
      const fix = await inA((c) => correctRecord(c, A, 'vet_visit', cat, v.id, sam, { visit_on: '2026-09-11', reason: 'Check-up' }, T));
      expect(fix).toMatchObject({ status: 'PROPOSED', supersedes_id: v.id });
      let ids = (await withTxn(A, true, (c) => listRecords(c, 'vet_visit', cat))).map((r) => r.id);
      expect(ids).toEqual(expect.arrayContaining([v.id, fix.id]));
      await inA((c) => confirmRecord(c, 'vet_visit', cat, fix.id, alex));
      ids = (await withTxn(A, true, (c) => listRecords(c, 'vet_visit', cat))).map((r) => r.id);
      expect(ids).toContain(fix.id);
      expect(ids).not.toContain(v.id);
      const kept = await withTxn(A, true, (c) => c.query<{ status: string }>('SELECT status FROM health.vet_visit WHERE vet_visit_id = $1', [v.id]));
      expect(kept.rows[0]!.status).toBe('SUPERSEDED');
      await inA((c) => disputeRecord(c, 'vet_visit', cat, fix.id, alex));
      expect((await withTxn(A, true, (c) => getTimeline(c, cat, alex))).some((e) => e.ref.table === 'vet_visit' && e.ref.id === fix.id)).toBe(false);
      await expect(inA((c) => disputeRecord(c, 'vet_visit', cat, fix.id, sam))).rejects.toMatchObject({ status: 403 });
    });
    it('every kind can be entered; dates must make sense; a visit of another animal cannot be linked', async () => {
      const visit = await inA((c) => addRecord(c, A, 'vet_visit', cat, alex, { visit_on: '2026-08-01', kind: 'ILLNESS', symptoms: 'sneezing', diagnosis_text: 'as written by the vet' }, T));
      await inA((c) => addRecord(c, A, 'treatment', cat, alex, { kind: 'FLEA', product: 'Spot-on', given_on: '2026-09-01', next_due_on: '2026-10-01' }, T));
      await inA((c) => addRecord(c, A, 'allergy', cat, alex, { substance: 'Chicken', substance_kind: 'FOOD', certainty: 'SUSPECTED' }, T));
      await inA((c) => addRecord(c, A, 'procedure', cat, alex, { name: 'Dental scale', performed_on: '2024', vet_visit_id: visit.id }, T));
      await inA((c) => addRecord(c, A, 'lab_result', cat, alex, { test: 'Bloods', analyte: 'ALT', value_printed: '45', unit_printed: 'U/L', ref_range_printed: '10-100', sampled_on: '2026-08-01' }, T));
      await expect(inA((c) => addRecord(c, A, 'vaccination', cat, alex, { vaccine: 'x', given_on: '2026-09-01', next_due_on: '2026-08-01' }, T))).rejects.toMatchObject({ status: 400 });
      await expect(inA((c) => addRecord(c, A, 'vaccination', cat, alex, { vaccine: 'x', given_on: '2027' }, T))).rejects.toMatchObject({ status: 400 });
      const other = (await inA((c) => createAnimal(c, A, alex, { name: 'Biscuit Three', species: 'cat' }, T))).id;
      await expect(inA((c) => addRecord(c, A, 'procedure', other, alex, { name: 'x', performed_on: '2025', vet_visit_id: visit.id }, T))).rejects.toMatchObject({ status: 400 });
      const h = await withTxn(A, true, (c) => getHealth(c, cat, kim));
      expect(h.records.procedure[0]).toMatchObject({ fields: { performed_on: '2024', performed_precision: 'YEAR', vet_visit_id: visit.id } });
      expect(h.records.lab_result[0]!.fields).toMatchObject({ value_printed: '45', flag_printed: null });
    });
  });

  describe('S4 medication (A18)', () => {
    it('start, change the dose, stop -> the derived current list follows; Owner / Primary carer only', async () => {
      let m = await inA((c) => addMedication(c, A, cat, alex, { product_name: 'Examplecillin', strength: '50 mg', start: { event_kind: 'STARTED', event_on: '2026-09-20', dose_text: 'half a tablet', frequency: 'twice a day', source: 'VET_ADVICE' } }, T));
      const med = m.medicines.find((x) => x.product_name === 'Examplecillin')!;
      expect(m.current).toMatchObject([{ product_name: 'Examplecillin', dose: 'half a tablet', since: '2026-09-20' }]);
      m = await inA((c) => addMedicationEvent(c, A, cat, med.id, alex, { event_kind: 'DOSE_CHANGED', event_on: '2026-10-01', dose_amount: 1, dose_unit: 'tablet' }, T));
      expect(m.current[0]).toMatchObject({ dose: '1 tablet', since: '2026-09-20' });
      expect((await withTxn(A, true, (c) => getAnimal(c, cat, alex, T))).current_medication).toMatchObject([{ product_name: 'Examplecillin', dose: '1 tablet' }]);
      await expect(inA((c) => addMedicationEvent(c, A, cat, med.id, sam, { event_kind: 'STOPPED' }, T))).rejects.toMatchObject({ status: 403 });
      await expect(inA((c) => addMedication(c, A, cat, sam, { product_name: 'x', start: { event_kind: 'STARTED' } }, T))).rejects.toMatchObject({ status: 403 });
      await expect(inA((c) => addMedicationEvent(c, A, cat, med.id, alex, { event_kind: 'STOPPED', event_on: '2026-09-01' }, T))).rejects.toMatchObject({ status: 400 });
      m = await inA((c) => addMedicationEvent(c, A, cat, med.id, alex, { event_kind: 'STOPPED', event_on: '2026-10-06', reason: 'course finished' }, T));
      expect(m.current).toEqual([]);
      expect(m.medicines.find((x) => x.id === med.id)).toMatchObject({ current: false });
      await expect(inA((c) => addMedicationEvent(c, A, cat, med.id, alex, { event_kind: 'STOPPED' }, T))).rejects.toMatchObject({ status: 409 });
      expect((await withTxn(A, true, (c) => getAnimal(c, cat, alex, T))).current_medication).toEqual([]);
      const tl = await withTxn(A, true, (c) => getTimeline(c, cat, alex, 'HEALTH'));
      expect(tl.filter((e) => e.ref.table === 'medication_event').map((e) => e.label)).toEqual(['Medicine stopped', 'Dose changed', 'Medicine started']);
    });
  });

  describe('contacts and the vet practice', () => {
    it('an Owner adds the vet practice and sets it on the animal; a member who manages no animal cannot add one', async () => {
      const vet = await inA((c) => addContact(c, A, alex, { kind: 'VET_PRACTICE', name: 'Example Vets', phone: '01 000 0000' }));
      const a = await inA((c) => updateAnimal(c, cat, alex, { vet_contact_id: vet.id }, T));
      expect(a.vet).toEqual({ id: vet.id, name: 'Example Vets', phone: '01 000 0000' });
      await expect(inA((c) => addContact(c, A, kim, { kind: 'PERSON', name: 'x' }))).rejects.toMatchObject({ status: 403 });
      expect((await withTxn(B, true, (c) => listContacts(c))).map((x) => x.id)).not.toContain(vet.id);
      await expect(withTxn(B, false, (c) => updateAnimal(c, cat, blair, { vet_contact_id: vet.id }, T))).rejects.toMatchObject({ status: 404 });
      const mine = (await withTxn(B, false, (c) => createAnimal(c, B, blair, biscuit, T))).id;
      await expect(withTxn(B, false, (c) => updateAnimal(c, mine, blair, { vet_contact_id: vet.id }, T))).rejects.toMatchObject({ status: 400 });
      expect((await withTxn(A, true, (c) => listAnimals(c, alex, T))).find((x) => x.id === cat)?.vet?.name).toBe('Example Vets');
    });
  });

  describe('HTTP (auth off, development only)', () => {
    let base = '';
    let server: import('node:http').Server;
    beforeAll(async () => {
      process.env.PETOPIA_AUTH = 'off';
      delete process.env.NODE_ENV;
      const { createApp } = await import('../src/server.js');
      server = createApp();
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      await new Promise((r) => server.close(r));
      delete process.env.PETOPIA_AUTH;
    });
    const as = (m: string) => ({ 'x-petopia-test-member': m, 'content-type': 'application/json' });
    const post = (m: string, p: string, body: unknown) => fetch(`${base}${p}`, { method: 'POST', headers: as(m), body: JSON.stringify(body) });

    it('the weight question comes back as 409 with the question and the suggestion', async () => {
      const r = await post(alex, `/api/animals/${cat}/measurements`, { measure: 'weight', value: 43, unit: 'kg' });
      expect(r.status).toBe(409);
      const j = (await r.json()) as Record<string, unknown>;
      expect(j).toMatchObject({ needs_confirmation: true, suggestion: { value: '4.3', unit: 'kg' } });
      expect(String(j.error)).toMatch(/did you mean 4\.3 kg/i);
    });
    it('microchip: bad format -> 400; a duplicate -> 409 in plain words, never Postgres text', async () => {
      expect((await post(alex, '/api/animals', { ...biscuit, microchip: '12-34' })).status).toBe(400);
      const chip = `9851${Date.now() % 1e10}`;
      expect((await post(alex, '/api/animals', { ...biscuit, microchip: chip })).status).toBe(201);
      const dup = await post(alex, '/api/animals', { ...biscuit, microchip: chip });
      expect(dup.status).toBe(409);
      const text = JSON.stringify(await dup.json());
      expect(text).toContain('already has that microchip');
      expect(text).not.toMatch(/duplicate key|constraint|uq_|workspace_id/);
    });
    it('photo upload: a Viewer is refused BEFORE the image is decoded (garbage bytes still get 403, not 400)', async () => {
      const r = await post(kim, `/api/animals/${cat}/photo`, { dataBase64: 'bm90IGFuIGltYWdl' });
      expect(r.status).toBe(403);
      expect((await post(alex, `/api/animals/${cat}/photo`, { dataBase64: 'bm90IGFuIGltYWdl' })).status).not.toBe(403);
    });
    it('records, timeline, health and feeding routes are role-checked server-side', async () => {
      expect((await post(kim, `/api/animals/${cat}/records/vaccination`, { vaccine: 'x', given_on: '2025' })).status).toBe(403);
      expect((await post(sam, `/api/animals/${cat}/feeding`, { brand: 'x', food_type: 'DRY' })).status).toBe(403);
      expect((await post(alex, `/api/animals/${cat}/records/nonsense`, {})).status).toBe(404);
      const fam = await post(sam, `/api/animals/${cat}/records/allergy`, { substance: 'Fish' });
      expect(fam.status).toBe(201);
      expect(((await fam.json()) as { status: string }).status).toBe('PROPOSED');
      for (const p of ['timeline', 'health', 'feeding', 'measurements?measure=weight']) {
        expect((await fetch(`${base}/api/animals/${cat}/${p}`, { headers: as(kim) })).status, p).toBe(200);
        expect((await fetch(`${base}/api/animals/${cat}/${p}`, { headers: as(blair) })).status, p).toBe(404);
      }
    });
  });
});
