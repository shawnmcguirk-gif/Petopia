// The HTTP layer without a database: health, fail-closed auth on every /api/ route, static serving of web/dist.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server.js';

let base = '';
let dist = '';
const server = createApp();

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), 'petopia-dist-'));
  await mkdir(join(dist, 'assets'));
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>Petopia</title>');
  await writeFile(join(dist, 'assets', 'app-abc.js'), 'console.log(1)');
  process.env.WEB_DIST = dist;
  delete process.env.PETOPIA_AUTH;
  process.env.PETOPIA_AUTH_VERIFY_URL = 'http://127.0.0.1:9/verify'; // nothing listens: unreachable
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await rm(dist, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('http', () => {
  it('GET /health needs no token', async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ok', service: 'petopia-engine' });
  });
  it('no token -> 401 on every API route (S2 acceptance: /petopia/api/me with no token is 401)', async () => {
    for (const [m, p] of [['GET', '/api/me'], ['GET', '/api/animals'], ['POST', '/api/animals'], ['GET', '/api/animals/1'], ['PATCH', '/api/animals/1'],
      ['POST', '/api/animals/1/photo'], ['GET', '/api/animals/1/measurements'], ['POST', '/api/animals/1/measurements'], ['GET', '/api/animals/1/feeding'],
      ['POST', '/api/animals/1/feeding'], ['GET', '/api/animals/1/health'], ['GET', '/api/animals/1/timeline'], ['POST', '/api/animals/1/records/vaccination'],
      ['POST', '/api/animals/1/records/vaccination/1/confirm'], ['POST', '/api/animals/1/medications'], ['POST', '/api/animals/1/medications/1/events'],
      ['GET', '/api/about/species/1'], ['GET', '/api/about/kind?name=Robin'], ['POST', '/api/animals/1/species'],
      ['GET', '/api/contacts'], ['POST', '/api/contacts'], ['GET', '/api/habitats'], ['GET', `/api/media/${'a'.repeat(64)}.jpg`], ['GET', '/api/nope']] as const) {
      const r = await fetch(`${base}${p}`, { method: m });
      expect(r.status, `${m} ${p}`).toBe(401);
      expect(await r.json()).toEqual({ error: 'missing device token' });
    }
  });
  it('a token the verifier cannot check -> 401 (fails closed)', async () => {
    const r = await fetch(`${base}/api/me`, { headers: { 'x-serenity-device': 'bogus' } });
    expect(r.status).toBe(401);
  });
  it('the test-member header does nothing while auth is on', async () => {
    const r = await fetch(`${base}/api/me`, { headers: { 'x-petopia-test-member': 'Alex' } });
    expect(r.status).toBe(401);
  });
  it('serves the web UI: index for client routes, hashed assets, no traversal or dotfiles', async () => {
    expect((await fetch(`${base}/`)).status).toBe(200);
    const deep = await fetch(`${base}/animals/3`);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('<title>Petopia</title>');
    const js = await fetch(`${base}/assets/app-abc.js`);
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/.env`)).status).toBe(404);
    const up = await fetch(`${base}/%2e%2e/etc/passwd`); // the URL is normalised to /etc/passwd: a client route, so index.html
    expect(await up.text()).toContain('<title>Petopia</title>');
    expect((await fetch(`${base}/..%2fsrc/server.ts`)).status).toBe(404);
  });
});
