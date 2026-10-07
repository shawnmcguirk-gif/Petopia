// S7 household + roles (A26, A27; spec sec 7). Runs only with PETOPIA_TEST_DATABASE_URL, over HTTP with auth off
// (development only; the test-member header). The key test WALKS THE ROUTE TABLE: every mutating route must refuse a
// Viewer, so a route added later without a guard fails here. Fictional fixtures only: "Biscuit", a cat.
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Reader } from '../src/reader.js';

const URL_ = process.env.PETOPIA_TEST_DATABASE_URL;
if (URL_) process.env.PETOPIA_DATABASE_URL = URL_;

const { grantHousehold, setAnimalRole } = await import('../src/access.js');
const { createAnimal } = await import('../src/animals.js');
const { closePool, withTxn } = await import('../src/db.js');
const { ROUTES, createApp } = await import('../src/server.js');

const run = `r${Date.now().toString(36)}`;
const who = (n: string) => `${run}-${n}`;
const T = '2026-10-07';

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

/** A concrete path for a route's pattern: the first id is `first`, any other id 1, a record kind "vaccination". */
function samplePath(re: RegExp, first: number): string {
  let s = re.source.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/');
  let firstDone = false;
  s = s.replace(/\(\\d\{1,15\}\)/g, () => { const v = firstDone ? '1' : String(first); firstDone = true; return v; });
  return s.replace('([a-z_]+)', 'vaccination').replace('(confirm|dispute)', 'confirm').replace('([^/]+)', `${'a'.repeat(64)}.jpg`);
}

describe.skipIf(!URL_)('S7 household + roles (database, HTTP)', () => {
  let A = 0;
  let cat = 0;
  let item = 0;
  let base = '';
  let root = '';
  const alex = who('alex'); // Owner, admin
  const sam = who('sam'); // Family
  const kim = who('kim'); // Viewer (on the only animal: a "household Viewer")
  const pat = who('pat');
  const reader: Reader = { kind: 'claude', read: () => Promise.reject(new Error('READER_NOT_STARTED')) };
  const server = createApp({ inbox: { get root() { return root; }, extractor: { textPages: () => Promise.resolve([]), ocrPage: () => Promise.resolve(''), ocrIdentity: () => Promise.resolve({ model_name: 'x', model_digest: null }) }, reader, local: null } });
  const call = async (as: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method, headers: { 'x-petopia-test-member': as, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> | null };
  };

  beforeAll(async () => {
    process.env.PETOPIA_AUTH = 'off';
    delete process.env.NODE_ENV;
    process.env.PETOPIA_ADMINS = alex;
    root = await mkdtemp(join(tmpdir(), 'petopia-roles-'));
    A = await newHousehold(alex);
    await withTxn(A, false, async (c) => { for (const m of [sam, kim, pat]) await grantHousehold(c, A, m, alex, [alex]); });
    cat = (await withTxn(A, false, (c) => createAnimal(c, A, alex, { name: 'Biscuit', species: 'cat', born: '2018' }, T))).id;
    await withTxn(A, false, (c) => setAnimalRole(c, A, cat, kim, 'VIEWER', alex));
    // an inbox item about Biscuit, so the item guard is exercised with an animal
    item = await withTxn(A, false, async (c) => {
      const d = (await c.query<{ id: number }>("INSERT INTO ingest.source_document (workspace_id, file_hash, vault_path, file_name, media_type, uploaded_by) VALUES ($1, $2, 'X/Pets/inbox/a.txt', 'a.txt', 'text/plain', $3) RETURNING source_document_id::int AS id", [A, 'b'.repeat(64), alex])).rows[0]!.id;
      return (await c.query<{ id: number }>("INSERT INTO ingest.inbox_item (workspace_id, source_document_id, member_name, status, animal_id) VALUES ($1, $2, $3, 'NEEDS_REVIEW', $4) RETURNING inbox_item_id::int AS id", [A, d, alex, cat])).rows[0]!.id;
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await closePool();
    await rm(root, { recursive: true, force: true });
    delete process.env.PETOPIA_AUTH;
    delete process.env.PETOPIA_ADMINS;
  });

  it('A27: every route has a guard, and no mutating route is guarded only by "household"', () => {
    for (const r of ROUTES) {
      expect(r.guard, `${r.method} ${r.path.source}`).toBeDefined();
      if (r.method !== 'GET') expect(r.guard.kind, `${r.method} ${r.path.source}`).not.toBe('household');
    }
    // the one "self" route: withdrawing your own go-ahead is always allowed (sec 5.1)
    expect(ROUTES.filter((r) => r.guard.kind === 'self').map((r) => r.path.source)).toEqual(['^\\/api\\/inbox\\/me\\/consent\\/withdraw$']);
  });

  it('A27: walking the route table -- every mutating route refuses a Viewer (403), before reading the body', async () => {
    const mutating = ROUTES.filter((r) => r.method !== 'GET' && r.guard.kind !== 'self');
    expect(mutating.length).toBeGreaterThanOrEqual(29);
    for (const r of mutating) {
      const path = samplePath(r.path, r.path.source.includes('inbox') ? item : cat);
      const res = await call(kim, r.method, path, { junk: true });
      expect(res.status, `${r.method} ${path}`).toBe(403);
    }
    // and the Viewer can still look
    expect((await call(kim, 'GET', `/api/animals/${cat}`)).status).toBe(200);
    expect((await call(kim, 'GET', '/api/today')).status).toBe(200);
    expect((await call(kim, 'GET', '/api/household')).status).toBe(200);
  });

  it('S7 acceptance: Viewer cannot log care; a Family member\'s vet-record entry becomes a proposal', async () => {
    expect((await call(kim, 'POST', `/api/animals/${cat}/care-log`, { kind: 'WALK' })).status).toBe(403);
    expect((await call(sam, 'POST', `/api/animals/${cat}/care-log`, { kind: 'WALK', note: 'round the block' })).status).toBe(201);
    const rec = await call(sam, 'POST', `/api/animals/${cat}/records/vaccination`, { vaccine: 'Cat flu', given_on: '2025-10-02' });
    expect(rec.status).toBe(201);
    expect(rec.body).toMatchObject({ status: 'PROPOSED', badge: { code: 'WAITING' } });
  });

  it('A26 / sec 7.2: roles are Owner-only; the last Owner cannot leave or step down until another Owner exists', async () => {
    expect((await call(sam, 'POST', `/api/animals/${cat}/roles`, { member_name: sam, role: 'OWNER' })).status).toBe(403);
    expect((await call(alex, 'POST', `/api/animals/${cat}/roles`, { member_name: alex, role: 'FAMILY' })).status).toBe(409);
    expect((await call(alex, 'POST', `/api/animals/${cat}/roles`, { member_name: alex, role: null })).status).toBe(409);
    expect((await call(alex, 'POST', `/api/animals/${cat}/roles`, { member_name: 'stranger', role: 'FAMILY' })).status).toBe(400); // no household access
    const ok = await call(alex, 'POST', `/api/animals/${cat}/roles`, { member_name: pat, role: 'PRIMARY_CARER' });
    expect(ok.status).toBe(200);
    const roles = (ok.body!.animals as { id: number; roles: { member_name: string; role: string; explicit: boolean }[] }[]).find((a) => a.id === cat)!.roles;
    expect(roles.find((r) => r.member_name === pat)).toEqual({ member_name: pat, role: 'PRIMARY_CARER', explicit: true });
    expect(roles.find((r) => r.member_name === sam)).toEqual({ member_name: sam, role: 'FAMILY', explicit: false });
    expect((await call(alex, 'POST', `/api/animals/${cat}/roles`, { member_name: sam, role: 'OWNER' })).status).toBe(200);
    expect((await call(alex, 'POST', `/api/animals/${cat}/roles`, { member_name: alex, role: 'FAMILY' })).status).toBe(200); // now allowed
    expect((await call(alex, 'POST', `/api/animals/${cat}/roles`, { member_name: alex, role: 'OWNER' })).status).toBe(403); // no longer an Owner
    expect((await call(sam, 'POST', `/api/animals/${cat}/roles`, { member_name: alex, role: 'OWNER' })).status).toBe(200);
  });

  it('A26: household access -- admin only, never your own, never the only Owner of an animal', async () => {
    expect((await call(sam, 'POST', '/api/household/members', { member_name: who('lee') })).status).toBe(403);
    const add = await call(alex, 'POST', '/api/household/members', { member_name: who('lee'), display_name: 'Lee', is_child: true });
    expect(add.status).toBe(201);
    expect((add.body!.members as { member_name: string; is_child: boolean }[]).find((m) => m.member_name === who('lee'))).toMatchObject({ is_child: true });
    expect((await call(alex, 'POST', '/api/household/members/revoke', { member_name: alex })).status).toBe(409);
    expect((await call(alex, 'POST', '/api/household/members/revoke', { member_name: who('lee') })).status).toBe(200);
    expect((await call(who('lee'), 'GET', '/api/animals')).status).toBe(403);
    // sam and alex are both Owners now: revoking sam is fine; then alex is the only Owner and cannot be revoked by anyone
    expect((await call(alex, 'POST', '/api/household/members/revoke', { member_name: sam })).status).toBe(200);
    expect((await call(sam, 'GET', '/api/animals')).status).toBe(403);
  });

  it('A26: habitats and contacts are added by an Owner / Primary carer only', async () => {
    expect((await call(kim, 'POST', '/api/habitats', { name: 'Pond', kind: 'POND' })).status).toBe(403);
    const h = await call(pat, 'POST', '/api/habitats', { name: 'Pond', kind: 'POND' });
    expect(h.status).toBe(201);
    expect((h.body!.habitats as { name: string }[]).map((x) => x.name)).toContain('Pond');
    expect((await call(pat, 'POST', '/api/contacts', { kind: 'VET_PRACTICE', name: 'Riverside Veterinary Clinic' })).status).toBe(201);
  });
});
