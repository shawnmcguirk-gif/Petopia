// Framework-free HTTP server, same shape as Vitalis's (spec sec 2). Every /api/ route: device token -> household grant ->
// the route's GUARD (checked before the body is read or anything decoded) -> one transaction on that household (FORCE
// RLS) -> the function, which checks the caller's role again before any read or write (defence in depth).
//
// The routes are one table (ROUTES, below) so the rule "every mutating route refuses a Viewer" (A27) is walked by a
// test over the table itself (test/roles.db.test.ts) rather than trusted route by route. Guards:
//   household        any member with household access (reads; the function filters what they may see)
//   animal:<Action>  the caller's role on /api/animals/:id allows <Action> (sec 7.2 via access.ts can())
//   any:<Action>     some animal allows <Action> for them (a "household Viewer" -- Viewer on every animal -- never does)
//   item:<Action>    an inbox item: its animal's role, or any:<Action> before an animal is decided
//   manages          Owner or Primary carer of at least one animal (contacts, habitats)
//   admin            PETOPIA_ADMINS (household access)
//   self             only ever about the caller's own consent: withdrawing a go-ahead is always allowed
// GET /health needs nothing; GET /api/me needs only a valid device. Anything that is not /api/ is the web UI.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { canAny, ensureAdminGrant, householdOf, isAdmin, managesAny, requireHousehold, requireOn, type Action } from './access.js';
import { createAnimal, getAnimal, listAnimals, mediaVisible, preparePhoto, setProfilePhoto, updateAnimal, type NewAnimal } from './animals.js';
import { authOff, authorise, isProduction } from './auth.js';
import { addAppointment, addRoutine, agenda, careOf, changeAppointment, logCare, rememberMember, retireRoutine, syncAppointment } from './care.js';
import { addContact, listContacts } from './contacts.js';
import { withTxn, type Client } from './db.js';
import { PetopiaError, bad, forbidden, fromPg, notFound } from './errors.js';
import { defaultExtractor } from './extract.js';
import { getFeeding, setFeeding } from './feeding.js';
import { listHabitats } from './habitats.js';
import { getHealth } from './health.js';
import { addHabitat, addMember, changeRole, household, removeMember } from './household.js';
import {
  acceptAllClean, addDocument, decide, documentFile, fileItem, getItem, itemAnimal, listItems, myInbox, requireSeeItem, retryRead, reviewProposal, setConsent, setFolder, waitingCount,
  type InboxDeps,
} from './inbox.js';
import { addMeasurement, listMeasurements } from './measurements.js';
import { addMedication, addMedicationEvent } from './medications.js';
import { MEDIA_NAME, readMedia, vaultRoot } from './photos.js';
import { claudeReader, localReader } from './reader.js';
import { addRecord, confirmRecord, correctRecord, disputeRecord, isKind } from './records.js';
import { getTimeline } from './timeline.js';
import { resolveInside } from './vault.js';
import { serveStatic } from './web.js';

type Body = Record<string, unknown>;
const PHOTO_MAX = 17 * 1024 * 1024; // 12 MB of photo as base64 JSON
const DOC_MAX = 21 * 1024 * 1024; // 15 MB of document as base64 JSON

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

// ---------------------------------------------------------------- the route table

export type Guard =
  | { kind: 'household' } | { kind: 'animal'; action: Action } | { kind: 'any'; action: Action } | { kind: 'item'; action: Action }
  | { kind: 'manages' } | { kind: 'admin' } | { kind: 'self' };
export interface Ctx {
  member: string; persona: string | undefined; ws: number; p: string[]; q: (k: string) => string | undefined; body: (max?: number) => Promise<Body>;
  res: ServerResponse; deps: () => InboxDeps;
  /** read-only / read-write transaction on the caller's household */
  r: <T>(fn: (c: Client) => Promise<T>) => Promise<T>; w: <T>(fn: (c: Client) => Promise<T>) => Promise<T>;
}
type Out = [number, unknown] | 'sent';
export interface Route { method: 'GET' | 'POST' | 'PATCH'; path: RegExp; guard: Guard; handle: (x: Ctx) => Promise<Out> }

const H: Guard = { kind: 'household' };
const A = (action: Action): Guard => ({ kind: 'animal', action });
const ANY = (action: Action): Guard => ({ kind: 'any', action });
const ITEM = (action: Action): Guard => ({ kind: 'item', action });
const ID = '(\\d{1,15})';
const re = (s: string) => new RegExp(`^/api/${s.replace(/:id/g, ID)}$`);
const n = (x: Ctx, i: number) => Number(x.p[i]);

export const ROUTES: Route[] = [
  { method: 'GET', path: re('habitats'), guard: H, handle: async (x) => [200, await x.r((c) => listHabitats(c))] },
  { method: 'POST', path: re('habitats'), guard: { kind: 'manages' }, handle: async (x) => { const b = await x.body(); return [201, await x.w((c) => addHabitat(c, x.ws, x.member, b))]; } },
  { method: 'GET', path: re('contacts'), guard: H, handle: async (x) => [200, await x.r((c) => listContacts(c))] },
  { method: 'POST', path: re('contacts'), guard: { kind: 'manages' }, handle: async (x) => { const b = await x.body(); return [201, await x.w((c) => addContact(c, x.ws, x.member, b))]; } },
  { method: 'GET', path: re('today'), guard: H, handle: async (x) => [200, await x.r(async (c) => ({ ...(await agenda(c, x.member)), inbox_waiting: await waitingCount(c, x.member) }))] },
  { method: 'GET', path: re('household'), guard: H, handle: async (x) => [200, await x.r((c) => household(c, x.ws, x.member))] },
  { method: 'POST', path: re('household/members'), guard: { kind: 'admin' }, handle: async (x) => { const b = await x.body(); return [201, await x.w((c) => addMember(c, x.ws, x.member, b))]; } },
  {
    method: 'POST', path: re('household/members/revoke'), guard: { kind: 'admin' }, handle: async (x) => {
      const b = await x.body();
      if (typeof b.member_name !== 'string' || !b.member_name.trim()) throw bad('member_name is required');
      return [200, await x.w((c) => removeMember(c, x.ws, x.member, (b.member_name as string).trim()))];
    },
  },

  // ---- animals
  { method: 'GET', path: re('animals'), guard: H, handle: async (x) => [200, await x.r((c) => listAnimals(c, x.member))] },
  { method: 'POST', path: re('animals'), guard: ANY('ADD_MEDIA'), handle: async (x) => { const b = (await x.body()) as NewAnimal; return [201, await x.w((c) => createAnimal(c, x.ws, x.member, b))]; } },
  { method: 'GET', path: re('animals/:id'), guard: A('VIEW'), handle: async (x) => [200, await x.r((c) => getAnimal(c, n(x, 1), x.member))] },
  { method: 'PATCH', path: re('animals/:id'), guard: A('EDIT_PROFILE'), handle: async (x) => { const b = await x.body(); return [200, await x.w((c) => updateAnimal(c, n(x, 1), x.member, b))]; } },
  {
    method: 'POST', path: re('animals/:id/photo'), guard: A('ADD_MEDIA'), handle: async (x) => {
      const root = vaultRoot();
      const b = await x.body(PHOTO_MAX);
      const processed = await preparePhoto(b.dataBase64);
      return [200, await x.w((c) => setProfilePhoto(c, x.ws, n(x, 1), x.member, processed, root))];
    },
  },
  { method: 'GET', path: re('animals/:id/measurements'), guard: A('VIEW'), handle: async (x) => [200, await x.r((c) => listMeasurements(c, n(x, 1), x.member, x.q('measure')))] },
  { method: 'POST', path: re('animals/:id/measurements'), guard: A('ADD_MEDIA'), handle: async (x) => { const b = await x.body(); return [201, await x.w((c) => addMeasurement(c, x.ws, n(x, 1), x.member, b))]; } },
  { method: 'GET', path: re('animals/:id/feeding'), guard: A('VIEW'), handle: async (x) => [200, await x.r((c) => getFeeding(c, n(x, 1), x.member))] },
  { method: 'POST', path: re('animals/:id/feeding'), guard: A('MANAGE_CARE'), handle: async (x) => { const b = await x.body(); return [201, await x.w((c) => setFeeding(c, x.ws, n(x, 1), x.member, b))]; } },
  { method: 'GET', path: re('animals/:id/health'), guard: A('VIEW'), handle: async (x) => [200, await x.r((c) => getHealth(c, n(x, 1), x.member))] },
  { method: 'GET', path: re('animals/:id/timeline'), guard: A('VIEW'), handle: async (x) => [200, await x.r((c) => getTimeline(c, n(x, 1), x.member, x.q('category')))] },
  { method: 'POST', path: re('animals/:id/medications'), guard: A('MANAGE_CARE'), handle: async (x) => { const b = await x.body(); return [201, await x.w((c) => addMedication(c, x.ws, n(x, 1), x.member, b))]; } },
  { method: 'POST', path: re('animals/:id/medications/:id/events'), guard: A('MANAGE_CARE'), handle: async (x) => { const b = await x.body(); return [201, await x.w((c) => addMedicationEvent(c, x.ws, n(x, 1), n(x, 2), x.member, b))]; } },
  {
    method: 'POST', path: re('animals/:id/records/([a-z_]+)'), guard: A('PROPOSE_RECORDS'), handle: async (x) => {
      const kind = x.p[2];
      if (!isKind(kind)) throw notFound('no such record kind');
      const b = await x.body();
      return [201, await x.w((c) => addRecord(c, x.ws, kind, n(x, 1), x.member, b))];
    },
  },
  {
    method: 'POST', path: re('animals/:id/records/([a-z_]+)/:id/(confirm|dispute)'), guard: A('CONFIRM_RECORDS'), handle: async (x) => {
      const kind = x.p[2];
      if (!isKind(kind)) throw notFound('no such record kind');
      if (x.p[4] === 'confirm') return [200, await x.w((c) => confirmRecord(c, kind, n(x, 1), n(x, 3), x.member))];
      return [200, await x.w((c) => disputeRecord(c, kind, n(x, 1), n(x, 3), x.member))];
    },
  },
  {
    method: 'POST', path: re('animals/:id/records/([a-z_]+)/:id/correct'), guard: A('PROPOSE_RECORDS'), handle: async (x) => {
      const kind = x.p[2];
      if (!isKind(kind)) throw notFound('no such record kind');
      const b = await x.body();
      return [201, await x.w((c) => correctRecord(c, x.ws, kind, n(x, 1), n(x, 3), x.member, b))];
    },
  },

  // ---- S6: care
  { method: 'GET', path: re('animals/:id/care'), guard: A('VIEW'), handle: async (x) => [200, await x.r((c) => careOf(c, n(x, 1), x.member))] },
  { method: 'POST', path: re('animals/:id/routines'), guard: A('MANAGE_CARE'), handle: async (x) => { const b = await x.body(); return [201, await x.w((c) => addRoutine(c, x.ws, n(x, 1), x.member, b))]; } },
  { method: 'POST', path: re('animals/:id/routines/:id/retire'), guard: A('MANAGE_CARE'), handle: async (x) => [200, await x.w((c) => retireRoutine(c, n(x, 1), n(x, 2), x.member))] },
  { method: 'POST', path: re('animals/:id/care-log'), guard: A('LOG_CARE'), handle: async (x) => { const b = await x.body(); return [201, await x.w((c) => logCare(c, x.ws, n(x, 1), x.member, b))]; } },
  {
    method: 'POST', path: re('animals/:id/appointments'), guard: A('MANAGE_CARE'), handle: async (x) => {
      const b = await x.body();
      const ap = await x.w((c) => addAppointment(c, x.ws, n(x, 1), x.member, b));
      return [201, await syncAppointment(x.ws, n(x, 1), ap.id, x.member, x.persona)];
    },
  },
  {
    method: 'PATCH', path: re('animals/:id/appointments/:id'), guard: A('MANAGE_CARE'), handle: async (x) => {
      const b = await x.body();
      await x.w((c) => changeAppointment(c, n(x, 1), n(x, 2), x.member, b));
      return [200, await syncAppointment(x.ws, n(x, 1), n(x, 2), x.member, x.persona)];
    },
  },
  { method: 'POST', path: re('animals/:id/appointments/:id/calendar'), guard: A('MANAGE_CARE'), handle: async (x) => [200, await syncAppointment(x.ws, n(x, 1), n(x, 2), x.member, x.persona)] },

  // ---- S7: roles
  { method: 'POST', path: re('animals/:id/roles'), guard: A('MANAGE_ROLES'), handle: async (x) => { const b = await x.body(); return [200, await x.w((c) => changeRole(c, x.ws, n(x, 1), x.member, b))]; } },

  // ---- S5: inbox
  { method: 'GET', path: re('inbox'), guard: H, handle: async (x) => [200, await x.r((c) => listItems(c, x.member))] },
  { method: 'GET', path: re('inbox/me'), guard: H, handle: async (x) => [200, await x.r((c) => myInbox(c, x.ws, x.member, x.deps().local !== null))] },
  { method: 'POST', path: re('inbox/me/folder'), guard: ANY('DROP_DOCUMENTS'), handle: async (x) => { const b = await x.body(); return [201, await x.w((c) => setFolder(c, x.ws, x.member, b, x.deps().local !== null))]; } },
  {
    method: 'POST', path: re('inbox/me/consent'), guard: ANY('DROP_DOCUMENTS'), handle: async (x) => {
      const b = await x.body();
      if (b.kind !== 'FOLDER_READ' && b.kind !== 'AI_READING') throw bad('kind must be FOLDER_READ or AI_READING');
      return [200, await x.w((c) => setConsent(c, x.ws, x.member, b.kind as 'FOLDER_READ' | 'AI_READING', true, x.deps().local !== null))];
    },
  },
  {
    method: 'POST', path: re('inbox/me/consent/withdraw'), guard: { kind: 'self' }, handle: async (x) => {
      const b = await x.body();
      if (b.kind !== 'FOLDER_READ' && b.kind !== 'AI_READING') throw bad('kind must be FOLDER_READ or AI_READING');
      return [200, await x.w((c) => setConsent(c, x.ws, x.member, b.kind as 'FOLDER_READ' | 'AI_READING', false, x.deps().local !== null))];
    },
  },
  { method: 'POST', path: re('inbox/documents'), guard: ANY('DROP_DOCUMENTS'), handle: async (x) => { const b = await x.body(DOC_MAX); return [201, await addDocument(x.ws, x.member, b, x.deps())]; } },
  { method: 'GET', path: re('inbox/:id'), guard: H, handle: async (x) => [200, await x.r((c) => getItem(c, n(x, 1), x.member))] },
  { method: 'POST', path: re('inbox/:id/decide'), guard: ITEM('DROP_DOCUMENTS'), handle: async (x) => { const b = await x.body(); return [200, await x.w((c) => decide(c, n(x, 1), x.member, b))]; } },
  { method: 'POST', path: re('inbox/:id/proposals/:id'), guard: ITEM('DROP_DOCUMENTS'), handle: async (x) => { const b = await x.body(); return [200, await x.w((c) => reviewProposal(c, n(x, 1), n(x, 2), x.member, b))]; } },
  { method: 'POST', path: re('inbox/:id/accept-all'), guard: ITEM('DROP_DOCUMENTS'), handle: async (x) => [200, await x.w((c) => acceptAllClean(c, n(x, 1), x.member))] },
  { method: 'POST', path: re('inbox/:id/file'), guard: ITEM('DROP_DOCUMENTS'), handle: async (x) => [200, await fileItem(x.ws, x.deps(), n(x, 1), x.member)] },
  { method: 'POST', path: re('inbox/:id/retry'), guard: ITEM('DROP_DOCUMENTS'), handle: async (x) => [200, await x.w((c) => retryRead(c, n(x, 1), x.member))] },
  {
    method: 'GET', path: re('documents/:id/file'), guard: H, handle: async (x) => {
      const d = await x.r((c) => documentFile(c, n(x, 1), x.member));
      const body = await readFile(await resolveInside(x.deps().root, d.vault_path)).catch(() => null);
      if (!body) throw notFound('the original file is not where it was filed');
      x.res.writeHead(200, {
        'content-type': d.media_type, 'content-disposition': `inline; filename="${d.file_name.replace(/[^\w. -]/g, '_')}"`, 'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      });
      x.res.end(body);
      return 'sent';
    },
  },
  {
    method: 'GET', path: /^\/api\/media\/([^/]+)$/, guard: H, handle: async (x) => {
      const m = MEDIA_NAME.exec(x.p[1]!);
      if (!m || !(await x.r((c) => mediaVisible(c, m[1]!)))) throw notFound('no such photo');
      const body = await readMedia(vaultRoot(), x.p[1]!);
      if (!body) throw notFound('no such photo');
      x.res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
      x.res.end(body);
      return 'sent';
    },
  },
];

/** The guard, checked in its own read-only transaction before the body is read. Throws 403/404. */
export async function checkGuard(c: Client, g: Guard, member: string, p: string[]): Promise<void> {
  switch (g.kind) {
    case 'household': case 'self': return;
    case 'animal': await requireOn(c, Number(p[1]), member, g.action); return;
    case 'any': if (!(await canAny(c, member, g.action))) throw forbidden('your role does not allow that'); return;
    case 'manages': if (!(await managesAny(c, member))) throw forbidden('only an Owner or Primary carer can do that'); return;
    case 'admin': if (!isAdmin(member)) throw forbidden('only a household admin can do that'); return;
    case 'item': {
      await requireSeeItem(c, Number(p[1]), member); // 404 first: someone who may not see it learns nothing (finding 2)
      const it = await itemAnimal(c, Number(p[1]));
      if (it.animal_id !== null) await requireOn(c, it.animal_id, member, g.action);
      else if (!(await canAny(c, member, g.action))) throw forbidden('your role does not allow that');
      return;
    }
  }
}

export interface AppDeps { inbox?: InboxDeps }
let envDeps: InboxDeps | null = null;
/** The inbox's real dependencies, from the environment (VAULT_ROOT, OLLAMA_URL, PETOPIA_CLAUDE_CMD, ...). */
export function inboxDepsFromEnv(): InboxDeps {
  envDeps ??= { root: vaultRoot(), extractor: defaultExtractor(), reader: claudeReader(), local: localReader() };
  return envDeps;
}

export function makeHandler(deps: AppDeps = {}) {
  const getDeps = (): InboxDeps => deps.inbox ?? inboxDepsFromEnv();
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
        if (ws !== null) await withTxn(ws, false, (c) => rememberMember(c, ws, member, v.persona));
        return send(res, 200, { member, household: ws === null ? null : { id: ws }, admin: isAdmin(member) });
      }

      // Everything below needs the household grant (deny by default).
      const ws = await withTxn(null, true, (c) => requireHousehold(c, member));
      let route: Route | undefined;
      let match: RegExpExecArray | null = null;
      for (const r of ROUTES) {
        if (r.method !== method) continue;
        match = r.path.exec(path);
        if (match) { route = r; break; }
      }
      if (!route || !match) return send(res, 404, { error: 'not found' });
      const p = [...match];
      await withTxn(ws, true, (c) => checkGuard(c, route.guard, member, p));
      const ctx: Ctx = {
        member, persona: v.persona, ws, p, q: (k) => url.searchParams.get(k) ?? undefined, body: (max) => readBody(req, max), res, deps: getDeps,
        r: (fn) => withTxn(ws, true, fn), w: (fn) => withTxn(ws, false, fn),
      };
      const out = await route.handle(ctx);
      if (out !== 'sent') send(res, out[0], out[1]);
    } catch (e) {
      const err = e instanceof PetopiaError ? e : fromPg(e);
      if (err) return send(res, err.status, { ...(err.extra ?? {}), error: err.message });
      console.error('petopia-engine: unhandled', e instanceof Error ? `${e.name}: ${e.message.replace(/\/[^\s:]+/g, '<path>')}` : 'non-error thrown');
      return send(res, 500, { error: 'internal error' });
    }
  };
}

export const handle = makeHandler();

export function createApp(deps: AppDeps = {}): Server {
  const h = makeHandler(deps);
  return createServer((req, res) => {
    void h(req, res);
  });
}
