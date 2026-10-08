// D2 A1 routes over HTTP with auth off (development only; the test-member header): GET about/species/:id, GET about/kind,
// POST animals/:id/species. The route-table walk in roles.db.test.ts already proves the POST refuses a Viewer; this checks the answers.
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL_ = process.env.PETOPIA_TEST_DATABASE_URL;
if (URL_) process.env.PETOPIA_DATABASE_URL = URL_;

const { grantHousehold, setAnimalRole } = await import('../src/access.js');
const { createAnimal, listSpecies } = await import('../src/animals.js');
const { closePool, withTxn } = await import('../src/db.js');
const { createApp } = await import('../src/server.js');

const run = `h${Date.now().toString(36)}`;
const alex = `${run}-alex`;
const kim = `${run}-kim`;
const T = '2026-10-08';

describe.skipIf(!URL_)('About routes (database, HTTP)', () => {
  let W = 0;
  let other = 0;
  let base = '';
  let rabbit = 0;
  const server = createApp();
  const call = async (as: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method, headers: { 'x-petopia-test-member': as, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> | null };
  };

  beforeAll(async () => {
    process.env.PETOPIA_AUTH = 'off';
    delete process.env.NODE_ENV;
    process.env.PETOPIA_ADMINS = alex;
    W = await withTxn(null, false, async (c) => {
      const id = Number((await c.query<{ id: string }>("SELECT nextval(pg_get_serial_sequence('core.workspace','workspace_id'))::text AS id")).rows[0]!.id);
      await c.query("SELECT set_config('app.current_workspace_id', $1, true)", [String(id)]);
      await c.query("INSERT INTO core.workspace (workspace_id, display_name, created_by) VALUES ($1, $2, 'test')", [id, `${run} household`]);
      await c.query("INSERT INTO core.habitat (workspace_id, name, kind, created_by) VALUES ($1, 'Home', 'HOME', 'test')", [id]);
      await c.query("INSERT INTO core.access_grant (workspace_id, member_name, granted_by) VALUES ($1, $2, 'test')", [id, alex]);
      return id;
    });
    await withTxn(W, false, (c) => grantHousehold(c, W, kim, alex, [alex]));
    other = (await withTxn(W, false, (c) => createAnimal(c, W, alex, { name: 'Hairy', species: 'Other animal', ext: { species_name: 'Zz mystery' } }, T))).id;
    await withTxn(W, false, (c) => setAnimalRole(c, W, other, kim, 'VIEWER', alex));
    rabbit = (await withTxn(W, true, (c) => listSpecies(c))).find((s) => s.name === 'Rabbit')!.id;
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await closePool();
    delete process.env.PETOPIA_AUTH;
    delete process.env.PETOPIA_ADMINS;
  });

  it('GET api/species says which species have a page', async () => {
    const r = await call(alex, 'GET', '/api/species');
    expect(r.status).toBe(200);
    expect((r.body as unknown as { name: string; has_about: boolean }[]).every((s) => typeof s.has_about === 'boolean')).toBe(true);
  });

  it('GET api/about/species/:id: no page is {state: NONE}, an unknown species is 404', async () => {
    expect(await call(alex, 'GET', `/api/about/species/${rabbit}`)).toMatchObject({ status: 200, body: expect.objectContaining({}) as unknown });
    const none = await call(kim, 'GET', '/api/about/species/99999999');
    expect(none.status).toBe(404);
  });

  it('GET api/about/kind?name=: resolves a typed kind, reads the name from the query, refuses a missing one', async () => {
    const budgie = await call(alex, 'GET', '/api/about/kind?name=Budgie');
    expect(budgie).toMatchObject({ status: 200, body: { tier: 'SPECIES', species: { common_name: 'Budgerigar' } } });
    const robin = await call(kim, 'GET', '/api/about/kind?name=%20robin%20');
    expect(robin).toMatchObject({ status: 200, body: { tier: 'SPECIES', wild: true } });
    expect(await call(alex, 'GET', '/api/about/kind?name=Zz%20mystery')).toMatchObject({ status: 200, body: { tier: 'NONE' } });
    expect((await call(alex, 'GET', '/api/about/kind')).status).toBe(400);
    expect((await call(alex, 'GET', '/api/about/kind?name=')).status).toBe(400);
  });

  it('a stranger (not in any household) is refused on both GET routes', async () => {
    const stranger = `${run}-stranger`;
    expect((await call(stranger, 'GET', '/api/about/kind?name=Robin')).status).toBe(403);
    expect((await call(stranger, 'GET', `/api/about/species/${rabbit}`)).status).toBe(403);
  });

  it('POST api/animals/:id/species refuses a body that is not a species', async () => {
    for (const body of [{}, { species: null }, { species: {} }, { species: [] }, { species: true }]) {
      const r = await call(alex, 'POST', `/api/animals/${other}/species`, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('POST api/animals/:id/species: a Viewer is refused, an editor switches it once, a second try is 409', async () => {
    expect((await call(kim, 'POST', `/api/animals/${other}/species`, { species: 'Rabbit' })).status).toBe(403);
    expect((await call(alex, 'POST', `/api/animals/${other}/species`, { species: 'Unicorn' })).status).toBe(404);
    expect((await call(alex, 'POST', `/api/animals/${other}/species`, { species: 'Robin' })).status).toBe(422);
    const ok = await call(alex, 'POST', `/api/animals/${other}/species`, { species: 'Rabbit' });
    expect(ok).toMatchObject({ status: 200, body: { species: 'Rabbit', module: 'rabbit', species_id: rabbit } });
    expect((await call(alex, 'POST', `/api/animals/${other}/species`, { species: 'Dog' })).status).toBe(409);
  });
});
