// S6 reminders + care log with a database (A22-A25; spec sec 3.5, 6, 9.3). Runs only with PETOPIA_TEST_DATABASE_URL.
// The Synapse events webhook is a local fake HTTP server (the real /webhook/events is only reachable on the iMac).
// Fictional fixtures only: "Biscuit", a cat.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL_ = process.env.PETOPIA_TEST_DATABASE_URL;
if (URL_) process.env.PETOPIA_DATABASE_URL = URL_;

const { grantHousehold, setAnimalRole } = await import('../src/access.js');
const { createAnimal } = await import('../src/animals.js');
const care = await import('../src/care.js');
const { closePool, withTxn } = await import('../src/db.js');
const { addMedication, addMedicationEvent } = await import('../src/medications.js');
const { addRecord } = await import('../src/records.js');
const { addDays } = await import('../src/rrule.js');

const run = `s${Date.now().toString(36)}`;
const who = (n: string) => `${run}-${n}`;
const T = '2026-10-07'; // a Wednesday

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

// ---- the fake Synapse events router
const seen: { headers: Record<string, unknown>; body: { action: string; persona_key: string; request_id: string; payload: Record<string, unknown> } }[] = [];
let eventsReply: 'ok' | 'fail' = 'ok';
const events: Server = createServer((req, res) => {
  let b = '';
  req.on('data', (d: Buffer) => { b += d.toString(); });
  req.on('end', () => {
    seen.push({ headers: req.headers, body: JSON.parse(b) as (typeof seen)[number]['body'] });
    if (eventsReply === 'fail') { res.writeHead(500); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, event: { id: 777 }, markdown: 'Saved. Google mirror: on' }));
  });
});

describe.skipIf(!URL_)('S6 reminders + care log (database)', () => {
  let A = 0;
  let cat = 0;
  const alex = who('alex'); // Owner
  const pat = who('pat'); // Primary carer
  const sam = who('sam'); // Family
  const kim = who('kim'); // Viewer
  const inA = <X,>(fn: (c: import('../src/db.js').Client) => Promise<X>) => withTxn(A, false, fn);
  const ag = (member: string) => withTxn(A, true, (c) => care.agenda(c, member, T));

  beforeAll(async () => {
    await new Promise<void>((r) => events.listen(0, '127.0.0.1', r));
    process.env.PETOPIA_EVENTS_URL = `http://127.0.0.1:${(events.address() as AddressInfo).port}/webhook/events`;
    process.env.PETOPIA_SERVICE_SECRET = 'test-service-secret';
    A = await newHousehold(alex);
    await inA(async (c) => { for (const m of [pat, sam, kim]) await grantHousehold(c, A, m, alex, [alex]); });
    cat = (await inA((c) => createAnimal(c, A, alex, { name: 'Biscuit', species: 'cat', born: '2018' }, T))).id;
    await inA(async (c) => { await setAnimalRole(c, A, cat, kim, 'VIEWER', alex); await setAnimalRole(c, A, cat, pat, 'PRIMARY_CARER', alex); });
  });
  afterAll(async () => { await closePool(); await new Promise((r) => events.close(r)); delete process.env.PETOPIA_SERVICE_SECRET; });

  it('A23: nothing set up -> Today and Coming Up are empty (the UI hides them); species defaults are only offered', async () => {
    expect(await ag(sam)).toEqual({ today: [], coming_up: [] });
    const view = await withTxn(A, true, (c) => care.careOf(c, cat, sam, T));
    expect(view.routines).toEqual([]);
    expect(view.suggestions.map((s) => s.kind)).toEqual(['GROOM', 'NAILS', 'TEETH', 'FLEA', 'WORM', 'VACCINATION']);
    const r = await withTxn(A, true, (c) => c.query('SELECT 1 FROM care.routine WHERE animal_id = $1', [cat]));
    expect(r.rowCount).toBe(0); // offered, never auto-created
  });

  it('A22: routines -- Owner / Primary carer only; species defaults must be the species\'; medicines must be current', async () => {
    await expect(inA((c) => care.addRoutine(c, A, cat, sam, { kind: 'FEED', rrule: 'FREQ=DAILY' }, T))).rejects.toMatchObject({ status: 403 });
    await expect(inA((c) => care.addRoutine(c, A, cat, alex, { kind: 'WALK', rrule: 'FREQ=DAILY', origin: 'SPECIES_DEFAULT' }, T))).rejects.toMatchObject({ status: 400 });
    await expect(inA((c) => care.addRoutine(c, A, cat, alex, { kind: 'FEED', rrule: 'FREQ=HOURLY' }, T))).rejects.toMatchObject({ status: 400 });
    await expect(inA((c) => care.addRoutine(c, A, cat, alex, { kind: 'GROOM', rrule: 'FREQ=WEEKLY', origin: 'VET_ADVICE' }, T))).rejects.toMatchObject({ status: 400 });
    await inA((c) => care.addRoutine(c, A, cat, alex, { kind: 'FEED', rrule: 'FREQ=DAILY', times: ['18:00', '08:00'], active_from: '2026-10-01' }, T));
    await inA((c) => care.addRoutine(c, A, cat, pat, { kind: 'GROOM', rrule: 'FREQ=WEEKLY', origin: 'SPECIES_DEFAULT', active_from: '2026-09-30' }, T)); // Wednesdays
    const flea = await inA((c) => care.addRoutine(c, A, cat, alex, { kind: 'FLEA', rrule: 'FREQ=MONTHLY', origin: 'SPECIES_DEFAULT', active_from: '2026-08-15' }, T));
    await inA((c) => c.query("UPDATE care.routine SET created_at = '2026-08-15T09:00:00Z' WHERE routine_id = $1", [flea.id])); // set up in August
    await inA((c) => care.addRoutine(c, A, cat, alex, { kind: 'VACCINATION', rrule: 'FREQ=YEARLY', origin: 'SPECIES_DEFAULT', active_from: '2025-10-20' }, T));
  });

  it('A23: Today (feed twice, grooming, an overdue flea treatment; no invented backlog) and Coming Up (next grooming, yearly vaccination), derived', async () => {
    const a = await ag(sam);
    expect(a.today.map((x) => `${x.kind}${x.time ? ` ${x.time}` : ''}${x.overdue ? ' overdue' : ''}`)).toEqual(['FLEA overdue', 'FEED 08:00', 'FEED 18:00', 'GROOM']); // timed first, then "any time today"
    expect(a.today.every((x) => x.can_log && x.animal === 'Biscuit')).toBe(true);
    expect(a.today.find((x) => x.kind === 'FLEA')).toMatchObject({ due_on: '2026-09-15', days: -22 });
    expect(a.coming_up.map((x) => `${x.kind} ${x.due_on}`)).toEqual(['GROOM 2026-10-14', 'FLEA 2026-10-15', 'VACCINATION 2026-10-20']);
    expect((await ag(kim)).today.every((x) => !x.can_log)).toBe(true); // a Viewer sees it, cannot tick it
  });

  it('A22: one-tap Done -- who and when; a second tap on another phone changes nothing and says who did it; Viewer refused', async () => {
    const feed = (await ag(sam)).today.find((x) => x.kind === 'FEED' && x.time === '08:00')!;
    const first = await inA((c) => care.logCare(c, A, cat, sam, { routine_id: feed.routine_id, due_on: T, due_slot: '08:00' }, T));
    expect(first).toMatchObject({ logged: true, by: sam });
    const again = await inA((c) => care.logCare(c, A, cat, alex, { routine_id: feed.routine_id, due_on: T, due_slot: '08:00' }, T));
    expect(again).toMatchObject({ logged: false, by: sam });
    await expect(inA((c) => care.logCare(c, A, cat, kim, { routine_id: feed.routine_id, due_on: T, due_slot: '18:00' }, T))).rejects.toMatchObject({ status: 403 });
    await expect(inA((c) => care.logCare(c, A, cat, sam, { routine_id: feed.routine_id, due_on: '2026-10-08', due_slot: '08:00' }, T))).rejects.toMatchObject({ status: 400 });
    await expect(inA((c) => care.logCare(c, A, cat, sam, { routine_id: feed.routine_id, due_on: T }, T))).rejects.toMatchObject({ status: 400 }); // which time?
    const flea = (await ag(sam)).today.find((x) => x.kind === 'FLEA')!;
    await inA((c) => care.logCare(c, A, cat, sam, { routine_id: flea.routine_id, due_on: flea.due_on }, T));
    expect((await ag(alex)).today.map((x) => `${x.kind}${x.time ? ` ${x.time}` : ''}`)).toEqual(['FEED 18:00', 'GROOM']);
    const rows = await withTxn(A, true, (c) => c.query('SELECT 1 FROM care.log WHERE animal_id = $1', [cat]));
    expect(rows.rowCount).toBe(2);
    await expect(inA((c) => c.query('DELETE FROM care.log WHERE animal_id = $1', [cat]))).rejects.toMatchObject({ code: '23514' });
  });

  it('sec 3.5: a due date the vet wrote wins over the routine of the same kind', async () => {
    await inA((c) => addRecord(c, A, 'vaccination', cat, alex, { vaccine: 'Cat flu', given_on: '2025-10-17', next_due_on: '2026-10-17', source: 'VET_RECORD' }, T));
    const up = (await ag(sam)).coming_up;
    expect(up.map((x) => `${x.kind} ${x.due_on}`)).toContain('VACCINATION_DUE 2026-10-17');
    expect(up.some((x) => x.kind === 'VACCINATION')).toBe(false);
  });

  it('A24: medication supply under 7 days -> "Prescription renewal approaching" in Coming Up', async () => {
    const meds = await inA((c) => addMedication(c, A, cat, alex, { product_name: 'Fictimab', start: { event_kind: 'STARTED', event_on: '2026-10-04', quantity_supplied: 10, dose_text: '1 tablet' } }, T));
    const med = meds.medicines[0]!.id;
    const r = await inA((c) => care.addRoutine(c, A, cat, alex, { kind: 'MEDICATION', medication_id: med, rrule: 'FREQ=DAILY', times: ['08:00', '20:00'], active_from: '2026-10-04' }, T));
    expect(r.origin).toBe('MEDICATION');
    expect((await ag(sam)).coming_up.some((x) => x.kind === 'PRESCRIPTION_RENEWAL')).toBe(true); // 10 doses / 2 a day = 5 days
    for (const d of ['2026-10-04', '2026-10-05', '2026-10-06']) for (const s of ['08:00', '20:00']) await inA((c) => care.logCare(c, A, cat, sam, { routine_id: r.id, due_on: d, due_slot: s }, T));
    const sup = (await ag(sam)).coming_up.find((x) => x.kind === 'PRESCRIPTION_RENEWAL')!;
    expect(sup).toMatchObject({ title: 'Prescription renewal approaching: Fictimab', due_on: addDays(T, 2), detail: 'about 2 days of doses left' });
    await inA((c) => addMedicationEvent(c, A, cat, med, alex, { event_kind: 'STOPPED', event_on: T }, T));
    expect((await ag(sam)).coming_up.some((x) => x.kind === 'PRESCRIPTION_RENEWAL')).toBe(false);
    await expect(inA((c) => care.addRoutine(c, A, cat, alex, { kind: 'MEDICATION', medication_id: med, rrule: 'FREQ=DAILY' }, T))).rejects.toMatchObject({ status: 409 });
  });

  it('A25: a vet appointment goes on the Primary carer\'s Synapse calendar, moves when the visit moves, and is cancelled with it', async () => {
    await inA((c) => care.rememberMember(c, A, pat, 'persona-pat'));
    await expect(inA((c) => care.addAppointment(c, A, cat, sam, { starts_on: '2026-10-12' }, T))).rejects.toMatchObject({ status: 403 });
    await expect(inA((c) => care.addAppointment(c, A, cat, alex, { starts_on: '2026-10-01' }, T))).rejects.toMatchObject({ status: 400 });
    const ap = await inA((c) => care.addAppointment(c, A, cat, alex, { starts_on: '2026-10-12', starts_time: '10:30', reason: 'annual check' }, T));
    const synced = await care.syncAppointment(A, cat, ap.id, alex, 'persona-alex');
    expect(synced).toMatchObject({ calendar_state: 'ON_GOOGLE', calendar_event_id: 777, calendar_persona: pat });
    expect(seen[0]!.headers['x-serenity-service']).toBe('test-service-secret');
    expect(seen[0]!.body).toMatchObject({ action: 'add', persona_key: 'persona-pat', payload: { title: 'Biscuit: vet — annual check', starts_at: '2026-10-12T09:30:00.000Z', tz: 'Europe/Dublin' } });
    expect((await ag(sam)).coming_up.find((x) => x.kind === 'VET_APPOINTMENT')).toMatchObject({ due_on: '2026-10-12', time: '10:30', title: 'Vet: annual check' });

    await inA((c) => care.changeAppointment(c, cat, ap.id, alex, { starts_on: '2026-10-13', starts_time: '15:00' }, T));
    await care.syncAppointment(A, cat, ap.id, alex, 'persona-alex');
    expect(seen[1]!.body).toMatchObject({ action: 'update', persona_key: 'persona-pat', payload: { event_id: 777, starts_at: '2026-10-13T14:00:00.000Z' } });

    await inA((c) => care.changeAppointment(c, cat, ap.id, alex, { state: 'CANCELLED' }, T));
    const gone = await care.syncAppointment(A, cat, ap.id, alex, 'persona-alex');
    expect(seen[2]!.body).toMatchObject({ action: 'cancel', payload: { event_id: 777 } });
    expect(gone).toMatchObject({ state: 'CANCELLED', calendar_event_id: null, calendar_state: null });
    expect((await ag(sam)).coming_up.some((x) => x.kind === 'VET_APPOINTMENT')).toBe(false);
    await expect(inA((c) => care.changeAppointment(c, cat, ap.id, alex, { starts_on: '2026-10-20' }, T))).rejects.toMatchObject({ status: 409 });
  });

  it('A25: the calendar failing never loses the appointment ("not on a calendar", retry); with no service secret nothing is sent', async () => {
    eventsReply = 'fail';
    const ap = await inA((c) => care.addAppointment(c, A, cat, alex, { starts_on: '2026-10-09' }, T));
    expect(await care.syncAppointment(A, cat, ap.id, alex)).toMatchObject({ state: 'BOOKED', calendar_state: 'FAILED' });
    eventsReply = 'ok';
    expect(await care.syncAppointment(A, cat, ap.id, alex)).toMatchObject({ calendar_state: 'ON_GOOGLE', calendar_event_id: 777 });
    const before = seen.length;
    delete process.env.PETOPIA_SERVICE_SECRET;
    const ap2 = await inA((c) => care.addAppointment(c, A, cat, alex, { starts_on: '2026-10-10' }, T));
    expect(await care.syncAppointment(A, cat, ap2.id, alex)).toMatchObject({ calendar_state: null });
    expect(seen.length).toBe(before);
    process.env.PETOPIA_SERVICE_SECRET = 'test-service-secret';
  });

  it('A3: the care tables are FORCE RLS; another or an unset household sees nothing', async () => {
    const r = await withTxn(null, true, (c) => c.query<{ t: string; ok: boolean }>(
      "SELECT c.relname AS t, c.relrowsecurity AND c.relforcerowsecurity AS ok FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'care' AND c.relkind = 'r'"));
    expect(r.rows.filter((x) => !x.ok)).toEqual([]);
    expect(r.rows.map((x) => x.t).sort()).toEqual(['appointment', 'log', 'routine']);
    const unset = await withTxn(null, true, (c) => c.query<{ n: number }>('SELECT ((SELECT count(*) FROM care.routine) + (SELECT count(*) FROM care.log) + (SELECT count(*) FROM care.appointment))::int AS n'));
    expect(unset.rows[0]!.n).toBe(0);
  });
  it('finding 12: a routine that names a source must name a real record of THIS animal, whatever its origin', async () => {
    const dog = (await inA((c) => createAnimal(c, A, alex, { name: 'Rusty', species: 'dog', born: '2020' }, T))).id;
    await inA((c) => addRecord(c, A, 'vaccination', dog, alex, { vaccine: 'Kennel cough', given_on: '2026-09-01', source: 'VET_RECORD' }, T));
    const rec = async (animal: number) => (await withTxn(A, true, (c) => c.query<{ id: number }>('SELECT vaccination_id::int AS id FROM health.vaccination WHERE animal_id = $1 ORDER BY vaccination_id LIMIT 1', [animal]))).rows[0]!.id;
    const dogVac = await rec(dog);
    const catVac = await rec(cat);
    const add = (body: Record<string, unknown>) => inA((c) => care.addRoutine(c, A, cat, alex, { kind: 'VACCINATION', rrule: 'FREQ=YEARLY', ...body }, T));
    await expect(add({ source_table: 'vaccination', source_id: dogVac })).rejects.toMatchObject({ status: 400 }); // Rusty's record on Biscuit's routine
    await expect(add({ origin: 'SPECIES_DEFAULT', source_table: 'vaccination', source_id: dogVac })).rejects.toMatchObject({ status: 400 });
    await expect(add({ source_table: 'vaccination', source_id: 999_999_999 })).rejects.toMatchObject({ status: 400 }); // no such record
    await expect(add({ source_id: catVac })).rejects.toMatchObject({ status: 400 }); // an id without its kind
    const ok = await add({ source_table: 'vaccination', source_id: catVac });
    expect(ok).toMatchObject({ origin: 'MANUAL', source: { table: 'vaccination', id: catVac } });
  });
});
