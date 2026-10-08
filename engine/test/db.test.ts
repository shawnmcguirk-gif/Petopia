// Rules that need Postgres (spec sec 4.2, 7, 12.1 S1 acceptance; A1, A3-A7). Runs only when PETOPIA_TEST_DATABASE_URL is
// set (the petopia_test database, never the live one -- Vitalis S2.8 #19), after bootstrap-db.sh + migrate.sh on it.
// Fixtures are fictional only: "Biscuit", a cat. Every run makes its own households, so nothing needs rolling back.
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL_ = process.env.PETOPIA_TEST_DATABASE_URL;
if (URL_) process.env.PETOPIA_DATABASE_URL = URL_;

const { endAnimalRole, grantHousehold, roleOn, setAnimalRole } = await import('../src/access.js');
const { createAnimal, getAnimal, listAnimals, updateAnimal } = await import('../src/animals.js');
const { closePool, withTxn } = await import('../src/db.js');
const { listHabitats } = await import('../src/habitats.js');

const run = `t${Date.now().toString(36)}`;
const who = (n: string) => `${run}-${n}`;
const T = '2026-10-07';

/** A fresh household with one Home habitat and a grant for `member` (test-only; the app has one household). */
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
const biscuit = { name: 'Biscuit', species: 'cat', breed: 'Domestic shorthair', born: '2018', ext: { indoor_outdoor: 'BOTH' } };

describe.skipIf(!URL_)('database rules (S1)', () => {
  let A = 0;
  let B = 0;
  beforeAll(async () => {
    A = await newHousehold(who('alex'));
    B = await newHousehold(who('blair'));
  });
  afterAll(async () => closePool());

  it('A1: CONNECT is revoked from PUBLIC on this database', async () => {
    const r = await withTxn(null, true, (c) => c.query<{ ok: boolean }>("SELECT has_database_privilege('public', current_database(), 'CONNECT') AS ok"));
    expect(r.rows[0]!.ok).toBe(false);
  });

  it('A3: every content table has FORCE RLS (only the access_grant and vault_folder_binding gates and ref.* do not)', async () => {
    const r = await withTxn(null, true, (c) => c.query<{ t: string; rls: boolean; force: boolean }>(
      `SELECT n.nspname || '.' || c.relname AS t, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname IN ('core','animal','media','ingest')`));
    const missing = r.rows.filter((x) => !['core.access_grant', 'core.vault_folder_binding'].includes(x.t) && !(x.rls && x.force)).map((x) => x.t);
    expect(missing).toEqual([]);
    expect(r.rows.map((x) => x.t)).toEqual(expect.arrayContaining(['core.workspace', 'core.habitat', 'core.animal_role', 'animal.animal', 'media.item', 'ingest.source_document']));
  });

  it('S1 acceptance: Biscuit, born 2018 (precision YEAR), shows age "about 8 years"', async () => {
    const a = await withTxn(A, false, (c) => createAnimal(c, A, who('alex'), biscuit, T));
    expect(a).toMatchObject({ name: 'Biscuit', species: 'Cat', module: 'cat', born: '2018', born_precision: 'YEAR', habitat: 'Home', my_role: 'OWNER', health_status: null, latest_weight: null, photo: null });
    expect(a.age?.text).toBe('about 8 years');
  });

  it('A3: household A sees nothing of B; an unset household sees nothing at all; writing into B from A is refused', async () => {
    const a = await withTxn(A, false, (c) => createAnimal(c, A, who('alex'), biscuit, T));
    expect((await withTxn(B, true, (c) => listAnimals(c, who('blair')))).map((x) => x.id)).not.toContain(a.id);
    await expect(withTxn(B, true, (c) => getAnimal(c, a.id, who('blair')))).rejects.toMatchObject({ status: 404 });
    const counts = await withTxn(null, true, (c) => c.query<{ n: string }>(
      `SELECT (SELECT count(*) FROM animal.animal) + (SELECT count(*) FROM core.habitat) + (SELECT count(*) FROM core.workspace)
            + (SELECT count(*) FROM core.animal_role) + (SELECT count(*) FROM media.item) + (SELECT count(*) FROM core.member) AS n`));
    expect(counts.rows[0]!.n).toBe('0');
    await expect(withTxn(A, false, (c) => c.query("INSERT INTO core.habitat (workspace_id, name, kind, created_by) VALUES ($1, 'Pond', 'POND', 'x')", [B])))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('A6: ext is validated by ajv against the module (422), the microchip is unique per household', async () => {
    await expect(withTxn(A, false, (c) => createAnimal(c, A, who('alex'), { ...biscuit, ext: { walk_minutes_target: 30 } }, T))).rejects.toMatchObject({ status: 422 });
    await expect(withTxn(A, false, (c) => createAnimal(c, A, who('alex'), { ...biscuit, species: 'unicorn' }, T))).rejects.toMatchObject({ status: 400 });
    const chip = `98510${Date.now() % 1e10}`;
    await withTxn(A, false, (c) => createAnimal(c, A, who('alex'), { ...biscuit, microchip: chip }, T));
    await expect(withTxn(A, false, (c) => createAnimal(c, A, who('alex'), { ...biscuit, microchip: chip }, T))).rejects.toMatchObject({ code: '23505' });
    await withTxn(B, false, (c) => createAnimal(c, B, who('blair'), { ...biscuit, microchip: chip }, T)); // another household may
  });

  it('A5: roles -- default Family, Viewer only looks, Family cannot edit the profile, last Owner cannot leave', async () => {
    await withTxn(A, false, async (c) => {
      await grantHousehold(c, A, who('sam'), who('alex'), [who('alex')]);
      await grantHousehold(c, A, who('kim'), who('alex'), [who('alex')]);
    });
    const a = await withTxn(A, false, (c) => createAnimal(c, A, who('alex'), biscuit, T));
    await withTxn(A, true, async (c) => expect(await roleOn(c, a.id, who('sam'))).toBe('FAMILY'));
    await expect(withTxn(A, false, (c) => updateAnimal(c, a.id, who('sam'), { breed: 'x' }, T))).rejects.toMatchObject({ status: 403 });
    await expect(withTxn(A, false, (c) => endAnimalRole(c, A, a.id, who('alex'), who('alex')))).rejects.toMatchObject({ status: 409 });
    await expect(withTxn(A, false, (c) => setAnimalRole(c, A, a.id, who('alex'), 'VIEWER', who('alex')))).rejects.toMatchObject({ status: 409 });
    await expect(withTxn(A, false, (c) => setAnimalRole(c, A, a.id, who('kim'), 'OWNER', who('sam')))).rejects.toMatchObject({ status: 403 });
    await expect(withTxn(A, false, (c) => setAnimalRole(c, A, a.id, who('stranger'), 'FAMILY', who('alex')))).rejects.toMatchObject({ status: 400 });
    await withTxn(A, false, (c) => setAnimalRole(c, A, a.id, who('kim'), 'VIEWER', who('alex')));
    await expect(withTxn(A, false, (c) => updateAnimal(c, a.id, who('kim'), { health_status: 'HEALTHY' }, T))).rejects.toMatchObject({ status: 403 });
    await withTxn(A, false, (c) => setAnimalRole(c, A, a.id, who('sam'), 'OWNER', who('alex')));
    await withTxn(A, false, (c) => endAnimalRole(c, A, a.id, who('alex'), who('alex'))); // another Owner remains
    await expect(withTxn(A, false, (c) => endAnimalRole(c, A, a.id, who('sam'), who('sam')))).rejects.toMatchObject({ status: 409 });
    const after = await withTxn(A, false, (c) => updateAnimal(c, a.id, who('sam'), { health_status: 'HEALTHY' }, T));
    expect(after.health_status).toBe('HEALTHY');
    await expect(withTxn(A, false, (c) => updateAnimal(c, a.id, who('alex'), { status: 'REHOMED' }, T))).rejects.toMatchObject({ status: 403 }); // alex is Family now
  });

  it('A7: the household (workspace 1) has Home and Garden seeded, Garden inside Home', async () => {
    const h = await withTxn(1, true, (c) => listHabitats(c));
    const home = h.find((x) => x.name === 'Home');
    expect(home?.kind).toBe('HOME');
    expect(h.find((x) => x.name === 'Garden')).toMatchObject({ kind: 'GARDEN', parent_id: home?.id });
  });

  describe('A4: the provenance block and its four rules, in the database', () => {
    const tbl = `pv_selftest.fact_${run}`;
    const base = { status: 'PROPOSED', source_class: 'OWNER_OBSERVATION', channel: 'MANUAL', extraction_method: 'MANUAL', proposed_by: 'Alex' };
    const ins = (row: Record<string, unknown>) => withTxn(A, false, async (c) => {
      const r = { ...base, ...row, workspace_id: A, v: 'x' };
      const cols = Object.keys(r);
      return (await c.query<{ fact_id: string }>(`INSERT INTO ${tbl} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING fact_id`, Object.values(r))).rows[0]!.fact_id;
    });
    beforeAll(async () => {
      await withTxn(null, false, async (c) => {
        await c.query('CREATE SCHEMA IF NOT EXISTS pv_selftest');
        await c.query(`CREATE TABLE ${tbl} (fact_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, workspace_id bigint NOT NULL REFERENCES core.workspace(workspace_id), v text, UNIQUE (workspace_id, fact_id))`);
        await c.query(`SELECT core.apply_provenance('${tbl}', 'fact_id')`);
        await c.query(`SELECT core.apply_provenance('${tbl}', 'fact_id')`); // idempotent
      });
    });
    afterAll(async () => withTxn(null, false, (c) => c.query(`DROP TABLE IF EXISTS ${tbl}`)));

    it('1. CONFIRMED needs confirmed_by', async () => {
      await expect(ins({ status: 'CONFIRMED' })).rejects.toMatchObject({ code: '23514' });
      await ins({ status: 'CONFIRMED', confirmed_by: 'Alex', confirmed_at: new Date().toISOString() });
    });
    it('2. channel DOCUMENT needs source_document_id', async () => {
      await expect(ins({ channel: 'DOCUMENT', extraction_method: 'TEXT_LAYER' })).rejects.toMatchObject({ code: '23514' });
    });
    it('3. an LLM_PROPOSAL can never be inserted as CONFIRMED; a person may promote it later', async () => {
      const doc = await withTxn(A, false, async (c) => (await c.query<{ id: string }>(
        `INSERT INTO ingest.source_document (workspace_id, file_hash, vault_path, file_name, media_type, uploaded_by) VALUES ($1, $2, 'Alex/Pets/inbox/a.pdf', 'a.pdf', 'application/pdf', 'Alex') RETURNING source_document_id AS id`,
        [A, `${Date.now().toString(16)}`.padStart(64, '0')])).rows[0]!.id);
      const llm = { source_class: 'VET_RECORD', channel: 'DOCUMENT', extraction_method: 'LLM_PROPOSAL', source_document_id: doc, source_page: 1, proposed_by: 'petopia-reader' };
      await expect(ins({ ...llm, status: 'CONFIRMED', confirmed_by: 'Alex', confirmed_at: new Date().toISOString() })).rejects.toMatchObject({ code: '23514' });
      const id = await ins(llm);
      await withTxn(A, false, (c) => c.query(`UPDATE ${tbl} SET status = 'CONFIRMED', confirmed_by = 'Alex', confirmed_at = now() WHERE fact_id = $1`, [id]));
      await expect(withTxn(A, false, (c) => c.query(`UPDATE ${tbl} SET extraction_method = 'MANUAL' WHERE fact_id = $1`, [id]))).rejects.toMatchObject({ code: '23514' });
      await expect(withTxn(A, false, (c) => c.query(`UPDATE ${tbl} SET status = 'PROPOSED' WHERE fact_id = $1`, [id]))).rejects.toMatchObject({ code: '23514' });
    });
    it('4. an AI_SUGGESTION can never be CONFIRMED, and the reader is never the confirmer', async () => {
      await expect(ins({ source_class: 'AI_SUGGESTION', status: 'CONFIRMED', confirmed_by: 'Alex', confirmed_at: new Date().toISOString() })).rejects.toMatchObject({ code: '23514' });
      const id = await ins({ source_class: 'AI_SUGGESTION' });
      await expect(withTxn(A, false, (c) => c.query(`UPDATE ${tbl} SET status = 'CONFIRMED', confirmed_by = 'Alex', confirmed_at = now() WHERE fact_id = $1`, [id]))).rejects.toMatchObject({ code: '23514' });
      await expect(ins({ status: 'CONFIRMED', confirmed_by: 'petopia-reader', confirmed_at: new Date().toISOString() })).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('HTTP with a database (auth off, development only)', () => {
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

    it('a member with no grant gets household null and 403 elsewhere', async () => {
      expect(await (await fetch(`${base}/api/me`, { headers: as(who('nobody')) })).json()).toEqual({ member: who('nobody'), household: null, admin: false });
      expect((await fetch(`${base}/api/animals`, { headers: as(who('nobody')) })).status).toBe(403);
    });
    it('POST /api/animals for Biscuit (born 2018, YEAR) returns "about N years"; PATCH and GET work', async () => {
      const r = await fetch(`${base}/api/animals`, { method: 'POST', headers: as(who('alex')), body: JSON.stringify(biscuit) });
      expect(r.status).toBe(201);
      const a = (await r.json()) as { id: number; age: { text: string } };
      expect(a.age.text).toBe(`about ${new Date().getFullYear() - 2018} years`);
      const p = await fetch(`${base}/api/animals/${a.id}`, { method: 'PATCH', headers: as(who('alex')), body: JSON.stringify({ sex: 'FEMALE' }) });
      expect(((await p.json()) as { sex: string }).sex).toBe('FEMALE');
      expect((await fetch(`${base}/api/animals/${a.id}`, { headers: as(who('blair')) })).status).toBe(404); // other household
      const list = (await (await fetch(`${base}/api/animals`, { headers: as(who('alex')) })).json()) as { id: number }[];
      expect(list.map((x) => x.id)).toContain(a.id);
      expect((await fetch(`${base}/api/habitats`, { headers: as(who('alex')) })).status).toBe(200);
    });
  });
});
