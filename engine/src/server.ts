// Framework-free HTTP server, same shape as Vitalis's (spec sec 2). Every /api/ route: device token -> household grant ->
// one transaction on that household (FORCE RLS) -> the caller's role on the animal, checked before any read or write.
//   GET  /health                      no auth; liveness only
//   GET  /api/me                      who am I, which household (null = no access yet)
//   GET  /api/animals                 Our Pets
//   POST /api/animals                 add an animal (creator becomes Owner)
//   GET  /api/animals/:id             one animal
//   PATCH /api/animals/:id            profile edits (role-checked per field group)
//   POST /api/animals/:id/photo       {dataBase64} -> re-encoded, metadata stripped, profile photo
//   GET  /api/habitats                Home, Garden, ...
//   GET  /api/media/<sha>.jpg         a stored photo, only if it belongs to the caller's household
// Anything else that is not /api/ is the web UI from web/dist.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ensureAdminGrant, householdOf, requireHousehold } from './access.js';
import { createAnimal, getAnimal, listAnimals, mediaVisible, preparePhoto, setProfilePhoto, updateAnimal, type NewAnimal } from './animals.js';
import { authOff, authorise, isProduction } from './auth.js';
import { withTxn } from './db.js';
import { PetopiaError, bad, fromPg, notFound } from './errors.js';
import { listHabitats } from './habitats.js';
import { MEDIA_NAME, readMedia, vaultRoot } from './photos.js';
import { serveStatic } from './web.js';

type Body = Record<string, unknown>;
const PHOTO_MAX = 17 * 1024 * 1024; // 12 MB of photo as base64 JSON

async function readBody(req: IncomingMessage, max = 64 * 1024): Promise<Body> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) throw new PetopiaError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw bad('body must be JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw bad('body must be a JSON object');
  return parsed as Body;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const h = req.headers[name];
  return Array.isArray(h) ? h[0] : h;
};

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const method = req.method ?? 'GET';
  try {
    if (method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok', service: 'petopia-engine' });
    if (!url.pathname.startsWith('/api/')) {
      if ((method === 'GET' || method === 'HEAD') && (await serveStatic(res, url.pathname))) return;
      return send(res, 404, { error: 'not found' });
    }

    // The test-member header is honoured only when auth is off, which itself is refused in production.
    const testMember = authOff() && !isProduction() ? header(req, 'x-petopia-test-member') : undefined;
    const v = await authorise(header(req, 'x-serenity-device'), testMember);
    if (!v.ok) return send(res, v.status, { error: v.reason });
    const member = v.member;
    const path = url.pathname;

    if (path === '/api/me' && method === 'GET') {
      const ws = await withTxn(null, false, async (c) => {
        await ensureAdminGrant(c, member);
        return householdOf(c, member);
      });
      return send(res, 200, { member, household: ws === null ? null : { id: ws } });
    }

    // Everything below needs the household grant (deny by default).
    const ws = await withTxn(null, true, (c) => requireHousehold(c, member));

    const media = /^\/api\/media\/([^/]+)$/.exec(path);
    if (media && method === 'GET') {
      const name = media[1]!;
      const m = MEDIA_NAME.exec(name);
      if (!m || !(await withTxn(ws, true, (c) => mediaVisible(c, m[1]!)))) throw notFound('no such photo');
      const body = await readMedia(vaultRoot(), name);
      if (!body) throw notFound('no such photo');
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
      res.end(body);
      return;
    }
    if (path === '/api/habitats' && method === 'GET') return send(res, 200, await withTxn(ws, true, (c) => listHabitats(c)));
    if (path === '/api/animals') {
      if (method === 'GET') return send(res, 200, await withTxn(ws, true, (c) => listAnimals(c, member)));
      if (method === 'POST') {
        const body = (await readBody(req)) as NewAnimal;
        return send(res, 201, await withTxn(ws, false, (c) => createAnimal(c, ws, member, body)));
      }
    }
    const one = /^\/api\/animals\/(\d{1,15})(\/photo)?$/.exec(path);
    if (one) {
      const id = Number(one[1]);
      if (!one[2] && method === 'GET') return send(res, 200, await withTxn(ws, true, (c) => getAnimal(c, id, member)));
      if (!one[2] && method === 'PATCH') {
        const body = await readBody(req);
        return send(res, 200, await withTxn(ws, false, (c) => updateAnimal(c, id, member, body)));
      }
      if (one[2] && method === 'POST') {
        const root = vaultRoot();
        const body = await readBody(req, PHOTO_MAX);
        const processed = await preparePhoto(body.dataBase64);
        return send(res, 200, await withTxn(ws, false, (c) => setProfilePhoto(c, ws, id, member, processed, root)));
      }
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    const err = e instanceof PetopiaError ? e : fromPg(e);
    if (err) return send(res, err.status, { error: err.message });
    console.error('petopia-engine: unhandled', e instanceof Error ? `${e.name}: ${e.message.replace(/\/[^\s:]+/g, '<path>')}` : 'non-error thrown');
    return send(res, 500, { error: 'internal error' });
  }
}

export function createApp(): Server {
  return createServer((req, res) => {
    void handle(req, res);
  });
}
