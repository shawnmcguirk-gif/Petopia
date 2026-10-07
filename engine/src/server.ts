// Framework-free HTTP server, same shape as Vitalis's (spec sec 2). Every /api/ route: device token -> household grant ->
// one transaction on that household (FORCE RLS) -> the caller's role on the animal, checked before any read or write.
//   GET  /health                      no auth; liveness only
//   GET  /api/me                      who am I, which household (null = no access yet)
//   GET  /api/animals                 Our Pets
//   POST /api/animals                 add an animal (creator becomes Owner)
//   GET  /api/animals/:id             one animal
//   PATCH /api/animals/:id            profile edits (role-checked per field group)
//   POST /api/animals/:id/photo       {dataBase64} -> re-encoded, metadata stripped, profile photo
//   GET  /api/animals/:id/measurements[?measure=weight]   confirmed readings with change since last (S3)
//   POST /api/animals/:id/measurements  a reading; 409 + question when it looks like a slip (confirm_unusual to save)
//   GET  /api/animals/:id/feeding     current food + history (S3)
//   POST /api/animals/:id/feeding     change the food (the old one is closed with an end date)
//   GET  /api/animals/:id/health      every vet record kind, medicines (+ derived current list), measurements (S4)
//   POST /api/animals/:id/records/:kind                    add (Owner/Primary carer confirmed; Family proposed)
//   POST /api/animals/:id/records/:kind/:rid/confirm|dispute|correct
//   POST /api/animals/:id/medications                      a new medicine with its first event
//   POST /api/animals/:id/medications/:mid/events          start again / dose change / stop
//   GET  /api/animals/:id/timeline[?category=HEALTH]       every event with its source badge
//   GET  /api/contacts, POST /api/contacts                 vet practice, emergency vet, ...
//   GET  /api/habitats                Home, Garden, ...
//   GET  /api/media/<sha>.jpg         a stored photo, only if it belongs to the caller's household
// Anything else that is not /api/ is the web UI from web/dist.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ensureAdminGrant, householdOf, requireHousehold, requireOn } from './access.js';
import { addContact, listContacts } from './contacts.js';
import { getFeeding, setFeeding } from './feeding.js';
import { getHealth } from './health.js';
import { addMeasurement, listMeasurements } from './measurements.js';
import { addMedication, addMedicationEvent } from './medications.js';
import { addRecord, confirmRecord, correctRecord, disputeRecord, isKind } from './records.js';
import { getTimeline } from './timeline.js';
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
    if (path === '/api/contacts') {
      if (method === 'GET') return send(res, 200, await withTxn(ws, true, (c) => listContacts(c)));
      if (method === 'POST') {
        const body = await readBody(req);
        return send(res, 201, await withTxn(ws, false, (c) => addContact(c, ws, member, body)));
      }
    }
    const one = /^\/api\/animals\/(\d{1,15})(?:\/([a-z_/0-9]+))?$/.exec(path);
    if (one) {
      const id = Number(one[1]);
      const rest = one[2] ?? '';
      const q = (k: string) => url.searchParams.get(k) ?? undefined;
      // Every route below checks the caller's role on this animal inside its own function, before any read or write.
      if (rest === '' && method === 'GET') return send(res, 200, await withTxn(ws, true, (c) => getAnimal(c, id, member)));
      if (rest === '' && method === 'PATCH') {
        const body = await readBody(req);
        return send(res, 200, await withTxn(ws, false, (c) => updateAnimal(c, id, member, body)));
      }
      if (rest === 'photo' && method === 'POST') {
        // The role is checked BEFORE the upload is read or decoded: a Viewer (or a stranger to this animal) never gets
        // to make the engine decode an image (independent review, 2026-10-07). setProfilePhoto checks it again.
        await withTxn(ws, true, (c) => requireOn(c, id, member, 'ADD_MEDIA'));
        const root = vaultRoot();
        const body = await readBody(req, PHOTO_MAX);
        const processed = await preparePhoto(body.dataBase64);
        return send(res, 200, await withTxn(ws, false, (c) => setProfilePhoto(c, ws, id, member, processed, root)));
      }
      if (rest === 'measurements') {
        if (method === 'GET') return send(res, 200, await withTxn(ws, true, (c) => listMeasurements(c, id, member, q('measure'))));
        if (method === 'POST') {
          const body = await readBody(req);
          return send(res, 201, await withTxn(ws, false, (c) => addMeasurement(c, ws, id, member, body)));
        }
      }
      if (rest === 'feeding') {
        if (method === 'GET') return send(res, 200, await withTxn(ws, true, (c) => getFeeding(c, id, member)));
        if (method === 'POST') {
          const body = await readBody(req);
          return send(res, 201, await withTxn(ws, false, (c) => setFeeding(c, ws, id, member, body)));
        }
      }
      if (rest === 'health' && method === 'GET') return send(res, 200, await withTxn(ws, true, (c) => getHealth(c, id, member)));
      if (rest === 'timeline' && method === 'GET') return send(res, 200, await withTxn(ws, true, (c) => getTimeline(c, id, member, q('category'))));
      if (rest === 'medications' && method === 'POST') {
        const body = await readBody(req);
        return send(res, 201, await withTxn(ws, false, (c) => addMedication(c, ws, id, member, body)));
      }
      const medEv = /^medications\/(\d{1,15})\/events$/.exec(rest);
      if (medEv && method === 'POST') {
        const body = await readBody(req);
        return send(res, 201, await withTxn(ws, false, (c) => addMedicationEvent(c, ws, id, Number(medEv[1]), member, body)));
      }
      const rec = /^records\/([a-z_]+)(?:\/(\d{1,15})\/(confirm|dispute|correct))?$/.exec(rest);
      if (rec && method === 'POST') {
        const kind = rec[1];
        if (!isKind(kind)) throw notFound('no such record kind');
        const rid = rec[2] ? Number(rec[2]) : null;
        const body = await readBody(req);
        if (rid === null) return send(res, 201, await withTxn(ws, false, (c) => addRecord(c, ws, kind, id, member, body)));
        if (rec[3] === 'confirm') return send(res, 200, await withTxn(ws, false, (c) => confirmRecord(c, kind, id, rid, member)));
        if (rec[3] === 'dispute') return send(res, 200, await withTxn(ws, false, (c) => disputeRecord(c, kind, id, rid, member)));
        return send(res, 201, await withTxn(ws, false, (c) => correctRecord(c, ws, kind, id, rid, member, body)));
      }
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    const err = e instanceof PetopiaError ? e : fromPg(e);
    if (err) return send(res, err.status, { ...(err.extra ?? {}), error: err.message });
    console.error('petopia-engine: unhandled', e instanceof Error ? `${e.name}: ${e.message.replace(/\/[^\s:]+/g, '<path>')}` : 'non-error thrown');
    return send(res, 500, { error: 'internal error' });
  }
}

export function createApp(): Server {
  return createServer((req, res) => {
    void handle(req, res);
  });
}
