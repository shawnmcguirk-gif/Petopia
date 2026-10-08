// The document inbox (spec sec 3.7, 4, 5; slice S5; A20, A21). Copied in shape from Vitalis inbox.ts / capturephoto.ts.
//
//   bind      each person has ONE folder, <Name>/Pets/inbox/ under VAULT_ROOT (core.vault_folder_binding);
//   go-ahead  nothing in it is read until THAT person says yes (FOLDER_READ), and no document text is sent to Claude
//             until they give the separate AI go-ahead (AI_READING) -- both recorded in core.consent_event, both off
//             until given (the DB CHECKs refuse anyone else's name). Without the AI go-ahead the local Ollama reader is
//             used if configured, else the document waits unread ("enter by hand", spec Q4);
//   discover  SHA-256 per file, idempotent (the same file twice is one document; a copy elsewhere is flagged);
//   read      text layer, or glm-ocr at home for pictures and scans -- the image itself never leaves the house;
//   assess    one document per reader call, ajv-validated, then the quote guard (guard.ts) drops and counts any value
//             not found on its page; what survives is a PROPOSAL (ingest.proposal), never a fact;
//   review    step 1 "what is it?" (animal, kind, date) then step 2, value by value: accept / correct / dismiss;
//   file      in ONE transaction the accepted values become rows (channel DOCUMENT, page + quote kept): CONFIRMED by an
//             Owner / Primary carer, PROPOSED when a Family member files (sec 7.2). Only AFTER that commit is the
//             original moved to <Name>/Pets/filed/<kind>/ -- never edited, never deleted; its SHA-256 stays recorded.
import { stat, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, extname } from 'node:path';
import { can, managesAny, requireAny, requireOn, type Role, roleOn } from './access.js';
import { todayIso } from './age.js';
import { toId, withTxn, type Client } from './db.js';
import { PetopiaError, bad, conflict, forbidden, notFound } from './errors.js';
import { extractDocument, type Extractor, type PageText } from './extract.js';
import { fieldsFit, guardAnswer } from './guard.js';
import { middayOf, moduleOfAnimal, previousReading } from './measurements.js';
import { normalise, plausibility, type Plausibility } from './measures.js';
import { insertRow } from './provenance.js';
import { checkAnswer, DOC_KINDS, type FactKind, type Reader } from './reader.js';
import { KINDS, recordColumns, type Kind } from './records.js';
import { S, bodyChecker } from './validate.js';
import { fileExists, filedPath, isImage, listInbox, mediaType, resolveInside, safeFileName, safeMove, sha256File, UNSUPPORTED_EXTENSIONS, INBOX_SUB } from './vault.js';

export interface InboxDeps {
  root: string;
  extractor: Extractor;
  /** Claude (needs the person's AI go-ahead). */
  reader: Reader;
  /** The local fallback, or null (then documents without the AI go-ahead wait unread). */
  local: Reader | null;
}

const MAX_FILE_BYTES = 40_000_000;
export const READER_NAME = 'petopia-reader';

export const folderWords = (folder: string): string =>
  `Petopia will read the files you put in "${folder}/Pets/inbox" in the household vault, to find your animals' records. It never edits or deletes them; it moves a file to "${folder}/Pets/filed" only after a person has checked it.`;
export const AI_WORDS = 'Petopia will send the TEXT of each document in your Pets inbox to Claude (Anthropic) to read it: one document at a time, never a photo or scan (those are read at home first). What it finds is only a suggestion until a person checks it. You can turn this off at any time.';

// ======================================================================== binding + go-ahead

interface Binding { workspace_id: number; member_name: string; vault_folder_name: string; go_ahead_at: string | null; ai_go_ahead_at: string | null }
async function bindingOf(c: Client, ws: number, member: string): Promise<Binding | null> {
  const r = await c.query<Binding & { workspace_id: string }>(
    'SELECT workspace_id::text, member_name, vault_folder_name, go_ahead_at::text, ai_go_ahead_at::text FROM core.vault_folder_binding WHERE workspace_id = $1 AND member_name = $2',
    [ws, member],
  );
  return r.rows[0] ? { ...r.rows[0], workspace_id: Number(r.rows[0].workspace_id) } : null;
}

export interface MyInbox { folder: string | null; suggested_folder: string; inbox_path: string | null; reading: boolean; ai_reading: boolean; folder_words: string; ai_words: string; local_reader: boolean }
export async function myInbox(c: Client, ws: number, member: string, localReader = false): Promise<MyInbox> {
  const b = await bindingOf(c, ws, member);
  const suggested = member.replace(/[^A-Za-z0-9 _.-]/g, '').trim().slice(0, 64) || 'Household';
  return {
    folder: b?.vault_folder_name ?? null, suggested_folder: suggested, inbox_path: b ? `${b.vault_folder_name}/${INBOX_SUB}` : null,
    reading: !!b?.go_ahead_at, ai_reading: !!b?.ai_go_ahead_at, folder_words: folderWords(b?.vault_folder_name ?? suggested), ai_words: AI_WORDS, local_reader: localReader,
  };
}

const checkFolder = bodyChecker<{ folder?: string }>(S.object({ folder: { type: 'string', minLength: 1, maxLength: 64 } }));
/** Choose your own folder (default: your name). Changing it later is not offered: files already filed stay where they are. */
export async function setFolder(c: Client, ws: number, member: string, body: unknown, localReader = false): Promise<MyInbox> {
  await requireAny(c, member, 'DROP_DOCUMENTS', 'a Viewer cannot add documents');
  const folder = (checkFolder(body).folder ?? (await myInbox(c, ws, member)).suggested_folder).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(folder) || folder.includes('..')) throw bad('a folder name is letters, digits, spaces, dots, dashes or underscores');
  if (await bindingOf(c, ws, member)) throw conflict('you already have a Pets folder');
  // macOS (the vault's disk) treats "Ryan" and "ryan" as ONE folder: compare case-insensitively (migration 014 enforces it).
  const taken = await c.query('SELECT 1 FROM core.vault_folder_binding WHERE lower(vault_folder_name) = lower($1)', [folder]);
  if (taken.rowCount) throw conflict('that folder already belongs to someone else');
  await c.query('INSERT INTO core.vault_folder_binding (workspace_id, member_name, vault_folder_name, created_by) VALUES ($1, $2, $3, $2)', [ws, member, folder]);
  return myInbox(c, ws, member, localReader);
}

/**
 * Give or withdraw your OWN go-ahead. Only ever for yourself: the binding is looked up by your name, and the database
 * refuses a go-ahead in anyone else's name. Each change is recorded with the words you were shown. Withdrawing is
 * always allowed, whatever your role.
 */
export async function setConsent(c: Client, ws: number, member: string, kind: 'FOLDER_READ' | 'AI_READING', given: boolean, localReader = false): Promise<MyInbox> {
  const b = await bindingOf(c, ws, member);
  if (!b) throw conflict('set up your Pets folder first');
  if (given) await requireAny(c, member, 'DROP_DOCUMENTS', 'a Viewer cannot add documents');
  if (given && kind === 'AI_READING' && !b.go_ahead_at) throw conflict('first say yes to Petopia reading your Pets folder');
  const col = kind === 'FOLDER_READ' ? 'go_ahead' : 'ai_go_ahead';
  if (given) await c.query(`UPDATE core.vault_folder_binding SET ${col}_by = $3, ${col}_at = COALESCE(${col}_at, now()) WHERE workspace_id = $1 AND member_name = $2`, [ws, member, member]);
  else await c.query(`UPDATE core.vault_folder_binding SET ${col}_by = NULL, ${col}_at = NULL WHERE workspace_id = $1 AND member_name = $2`, [ws, member]);
  await c.query('INSERT INTO core.consent_event (workspace_id, member_name, kind, given, words_shown) VALUES ($1, $2, $3, $4, $5)',
    [ws, member, kind, given, kind === 'FOLDER_READ' ? folderWords(b.vault_folder_name) : AI_WORDS]);
  if (!given && kind === 'FOLDER_READ' && b.ai_go_ahead_at) {
    // No folder reading means no AI reading either: withdrawn too, and recorded as its own consent event.
    await c.query('UPDATE core.vault_folder_binding SET ai_go_ahead_by = NULL, ai_go_ahead_at = NULL WHERE workspace_id = $1 AND member_name = $2', [ws, member]);
    await c.query('INSERT INTO core.consent_event (workspace_id, member_name, kind, given, words_shown) VALUES ($1, $2, $3, false, $4)', [ws, member, 'AI_READING', AI_WORDS]);
  }
  return myInbox(c, ws, member, localReader);
}

// ======================================================================== discover / read / assess (engine-owned)

interface Item { id: number; doc: number; member_name: string; status: string; vault_path: string; file_name: string; media_type: string; flags: string[]; discovered_at: string }
const ITEM_SQL = `SELECT i.inbox_item_id::int AS id, d.source_document_id::int AS doc, i.member_name, i.status, d.vault_path, d.file_name, d.media_type, i.flags,
                         d.discovered_at::date::text AS discovered_at
                    FROM ingest.inbox_item i JOIN ingest.source_document d ON d.workspace_id = i.workspace_id AND d.source_document_id = i.source_document_id`;

export interface ScanReport { discovered: number; duplicates: number; moved: number }
/** Register every new file in one person's inbox folder. Reads nothing without their go-ahead. */
export async function scanFolder(ws: number, deps: InboxDeps, b: Binding): Promise<ScanReport> {
  const rep: ScanReport = { discovered: 0, duplicates: 0, moved: 0 };
  if (!b.go_ahead_at) return rep;
  const entries: { rel: string; hash: string; size: number }[] = [];
  for (const rel of await listInbox(deps.root, b.vault_folder_name)) {
    const abs = await resolveInside(deps.root, rel);
    entries.push({ rel, hash: await sha256File(abs), size: (await stat(abs)).size });
  }
  if (!entries.length) return rep;
  await withTxn(ws, false, async (c) => {
    for (const e of entries) {
      const name = basename(e.rel);
      const found = await c.query<{ id: string; vault_path: string }>('SELECT source_document_id::text AS id, vault_path FROM ingest.source_document WHERE file_hash = $1', [e.hash]);
      if (!found.rows[0]) {
        const d = await insertRow(c, 'ingest.source_document', 'source_document_id', {
          workspace_id: ws, file_hash: e.hash, vault_path: e.rel, original_relpath: e.rel, file_name: name, media_type: mediaType(name), uploaded_by: b.member_name,
        });
        const unsupported = e.size > MAX_FILE_BYTES || UNSUPPORTED_EXTENSIONS.includes(extname(name).toLowerCase());
        await c.query('INSERT INTO ingest.inbox_item (workspace_id, source_document_id, member_name, status, flags) VALUES ($1, $2, $3, $4, $5)',
          [ws, d, b.member_name, unsupported ? 'NEEDS_REVIEW' : 'DISCOVERED', unsupported ? ['UNSUPPORTED'] : []]);
        rep.discovered++;
        continue;
      }
      const doc = found.rows[0];
      if (doc.vault_path === e.rel) continue;
      let oldThere = false;
      try { oldThere = await fileExists(await resolveInside(deps.root, doc.vault_path)); } catch { oldThere = false; }
      if (oldThere) {
        // Same bytes in two places: a possible duplicate for a person to dismiss (sec 5.2 rules); the copy is not read again.
        await c.query("UPDATE ingest.inbox_item SET flags = array_append(flags, 'POSSIBLE_DUPLICATE'), updated_at = now() WHERE source_document_id = $1 AND NOT ('POSSIBLE_DUPLICATE' = ANY(flags))", [toId(doc.id)]);
        rep.duplicates++;
      } else {
        await c.query('UPDATE ingest.source_document SET vault_path = $2 WHERE source_document_id = $1', [toId(doc.id), e.rel]);
        rep.moved++;
      }
    }
  });
  return rep;
}

/** SQL condition on inbox_item `i`: its folder's person has (still) given the go-ahead to read it. Checked at EVERY
 *  stage -- sweep, read, assess -- so a withdrawal stops reading at once (independent review, finding 1). */
const GO_AHEAD = 'EXISTS (SELECT 1 FROM core.vault_folder_binding b WHERE b.workspace_id = i.workspace_id AND b.member_name = i.member_name AND b.go_ahead_at IS NOT NULL)';
const AI_GO_AHEAD = 'EXISTS (SELECT 1 FROM core.vault_folder_binding b WHERE b.workspace_id = i.workspace_id AND b.member_name = i.member_name AND b.go_ahead_at IS NOT NULL AND b.ai_go_ahead_at IS NOT NULL)';
/** Inside the transaction that would KEEP what was read: is the go-ahead still there? Locks the item and its folder's
 *  binding (FOR SHARE), so a withdrawal in flight either commits first and is seen here, or waits until this commits. */
async function stillAllowed(c: Client, id: number, needAi: boolean): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM ingest.inbox_item i JOIN core.vault_folder_binding b ON b.workspace_id = i.workspace_id AND b.member_name = i.member_name
      WHERE i.inbox_item_id = $1 AND b.go_ahead_at IS NOT NULL${needAi ? ' AND b.ai_go_ahead_at IS NOT NULL' : ''} FOR UPDATE OF i FOR SHARE OF b`, [id]);
  return !!r.rowCount;
}

/** DISCOVERED -> READ: the text of every page (text layer, else OCR at home). An unreadable file waits for a person.
 *  Returns false when nothing was read (no go-ahead, or it was withdrawn meanwhile). */
export async function readText(ws: number, deps: InboxDeps, item: Item): Promise<boolean> {
  const claimed = await withTxn(ws, false, async (c) => (await c.query(
    `UPDATE ingest.inbox_item i SET status = 'READ', updated_at = now() WHERE inbox_item_id = $1 AND status = 'DISCOVERED' AND ${GO_AHEAD}`, [item.id])).rowCount);
  if (!claimed) return false;
  let out;
  try {
    out = await extractDocument(deps.extractor, await resolveInside(deps.root, item.vault_path));
  } catch {
    out = { method: 'TEXT_LAYER' as const, status: 'FAILED' as const, pages: [] as PageText[], identity: null, error: 'READ_FAILED' };
  }
  return withTxn(ws, false, async (c) => {
    // the go-ahead was withdrawn while the file was being read: keep nothing of it, and put it back to wait
    if (!(await stillAllowed(c, item.id, false))) {
      await c.query("UPDATE ingest.inbox_item SET status = 'DISCOVERED', updated_at = now() WHERE inbox_item_id = $1 AND status = 'READ'", [item.id]);
      return false;
    }
    const run = await insertRow(c, 'ingest.extraction_run', 'extraction_run_id', {
      workspace_id: ws, inbox_item_id: item.id, method: out.method, status: out.status, model: out.identity?.model_name ?? null, pages: out.pages.length,
      errors: out.error ? out.error.split(deps.root).join('<vault>').slice(0, 200) : null,
    });
    for (const p of out.pages) await c.query('INSERT INTO ingest.page_text (workspace_id, inbox_item_id, extraction_run_id, page, text) VALUES ($1, $2, $3, $4, $5)', [ws, item.id, run, p.page, p.text]);
    if (out.status !== 'OK') {
      await c.query("UPDATE ingest.inbox_item SET status = 'NEEDS_REVIEW', flags = array_append(flags, $2), updated_at = now() WHERE inbox_item_id = $1",
        [item.id, isImage(item.file_name) ? 'NO_TEXT_FOUND' : 'UNREADABLE']);
    }
    return true;
  });
}

async function latestPages(c: Client, itemId: number): Promise<{ run: number; method: string; pages: PageText[] } | null> {
  const r = await c.query<{ run: string; method: string }>(
    "SELECT extraction_run_id::text AS run, method FROM ingest.extraction_run WHERE inbox_item_id = $1 AND method IN ('TEXT_LAYER','OCR') AND status = 'OK' ORDER BY extraction_run_id DESC LIMIT 1", [itemId]);
  if (!r.rows[0]) return null;
  const p = await c.query<{ page: number; text: string }>('SELECT page, text FROM ingest.page_text WHERE extraction_run_id = $1 ORDER BY page', [toId(r.rows[0].run)]);
  return { run: toId(r.rows[0].run), method: r.rows[0].method, pages: p.rows };
}

/** Pick the reader this person allows: Claude only with their AI go-ahead; else the local model; else none. Pure. */
export function chooseReader(aiGoAhead: boolean, deps: Pick<InboxDeps, 'reader' | 'local'>): Reader | null {
  return aiGoAhead ? deps.reader : deps.local;
}

/** Microchip first (the strongest key), then name + species. Ambiguous or nothing -> null: it asks, never guesses. */
export async function matchAnimal(c: Client, a: { name: string | null; species: string | null; microchip: string | null }): Promise<number | null> {
  if (a.microchip) {
    const r = await c.query<{ id: string }>('SELECT animal_id::text AS id FROM animal.animal WHERE microchip = $1', [a.microchip]);
    if (r.rows.length === 1) return toId(r.rows[0]!.id);
  }
  if (a.name) {
    const r = await c.query<{ id: string; species: string; label: string | null }>(
      "SELECT a.animal_id::text AS id, lower(s.common_name) AS species, lower(a.ext->>'species_name') AS label FROM animal.animal a JOIN ref.species s ON s.species_id = a.species_id WHERE lower(a.name) = lower($1)", [a.name]);
    const sp = a.species?.toLowerCase().trim();
    // A document says "Rabbit" or "tarantula", so match the species' own name, or what the person typed for "Other animal".
    const words = (needle: string | null): boolean => !!needle && new RegExp(`(^|[^a-z])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?($|[^a-z])`).test(sp!);
    const hits = sp ? r.rows.filter((x) => words(x.species) || words(x.label)) : r.rows;
    if (hits.length === 1) return toId(hits[0]!.id);
  }
  return null;
}

/** READ -> NEEDS_REVIEW (or ASSESS_FAILED): one reader call, ajv, the quote guard, proposals. Never writes a fact. */
export async function assess(ws: number, deps: InboxDeps, item: Item): Promise<'ASSESSED' | 'WAITING' | 'FAILED' | 'SKIPPED'> {
  const pre = await withTxn(ws, true, async (c) => ({ text: await latestPages(c, item.id), b: await bindingOf(c, ws, item.member_name) }));
  if (!pre.text) return 'SKIPPED';
  if (!pre.b?.go_ahead_at) return 'SKIPPED'; // folder go-ahead withdrawn: nothing more is read from it
  const reader = chooseReader(!!pre.b.ai_go_ahead_at, deps);
  if (!reader) {
    // No go-ahead to send it to Claude and no local reader: it waits, unread (spec Q4). The person can enter it by hand.
    await withTxn(ws, false, (c) => c.query("UPDATE ingest.inbox_item SET flags = array_append(flags, 'AWAITING_AI_GO_AHEAD'), updated_at = now() WHERE inbox_item_id = $1 AND NOT ('AWAITING_AI_GO_AHEAD' = ANY(flags))", [item.id]));
    return 'WAITING';
  }
  // The claim re-checks, in the same statement, the go-ahead this reader needs: a withdrawal that lands after `pre` was
  // read still stops the document going to Claude (or to the local model, without the folder go-ahead).
  const claimed = await withTxn(ws, false, async (c) => (await c.query(
    `UPDATE ingest.inbox_item i SET status = 'ASSESSED', flags = array_remove(flags, 'AWAITING_AI_GO_AHEAD'), updated_at = now()
      WHERE inbox_item_id = $1 AND status = 'READ' AND ${reader.kind === 'claude' ? AI_GO_AHEAD : GO_AHEAD}`, [item.id])).rowCount);
  if (!claimed) return 'SKIPPED';
  const method = reader.kind === 'claude' ? 'LLM_PROPOSAL' : 'LOCAL_MODEL';
  let result;
  try {
    result = await reader.read(pre.text.pages);
  } catch (e) {
    const code = e instanceof Error && /^READER_[A-Z_]+$/.test(e.message) ? e.message : 'READER_FAILED';
    await withTxn(ws, false, async (c) => {
      await insertRow(c, 'ingest.extraction_run', 'extraction_run_id', { workspace_id: ws, inbox_item_id: item.id, method, status: 'FAILED', errors: code });
      await c.query("UPDATE ingest.inbox_item SET status = 'ASSESS_FAILED', updated_at = now() WHERE inbox_item_id = $1", [item.id]);
    });
    return 'FAILED';
  }
  const checked = checkAnswer(result.output);
  const usage = { model: result.model, cli_version: result.cli_version, input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens, cost_usd: result.usage.cost_usd };
  if (!checked.ok) {
    await withTxn(ws, false, async (c) => {
      await insertRow(c, 'ingest.extraction_run', 'extraction_run_id', { workspace_id: ws, inbox_item_id: item.id, method, status: 'INVALID', valid: false, errors: checked.errors.slice(0, 200), ...usage });
      await c.query("UPDATE ingest.inbox_item SET status = 'ASSESS_FAILED', updated_at = now() WHERE inbox_item_id = $1", [item.id]);
    });
    return 'FAILED';
  }
  const g = guardAnswer(checked.answer, pre.text.pages);
  const kept = await withTxn(ws, false, async (c) => {
    if (!(await stillAllowed(c, item.id, reader.kind === 'claude'))) {
      // The go-ahead was withdrawn while the reader was working: nothing of its answer is kept (no values, no page
      // references), only the run and its cost, and the document goes back to waiting (finding 1, in flight).
      await insertRow(c, 'ingest.extraction_run', 'extraction_run_id', { workspace_id: ws, inbox_item_id: item.id, method, status: 'FAILED', errors: 'GO_AHEAD_WITHDRAWN', ...usage });
      await c.query("UPDATE ingest.inbox_item SET status = 'READ', updated_at = now() WHERE inbox_item_id = $1 AND status = 'ASSESSED'", [item.id]);
      return false;
    }
    const run = await insertRow(c, 'ingest.extraction_run', 'extraction_run_id', {
      workspace_id: ws, inbox_item_id: item.id, method, status: 'OK', valid: true, dropped: g.dropped, pages: pre.text!.pages.length,
      errors: g.reasons.length ? [...new Set(g.reasons)].join(',') : null, ...usage,
    });
    for (const f of g.is_pet_document ? g.facts : []) {
      await c.query('INSERT INTO ingest.proposal (workspace_id, inbox_item_id, extraction_run_id, target, payload, page, quote, flags) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [ws, item.id, run, f.kind, JSON.stringify(f.fields), f.page, f.quote, f.flags]);
    }
    const animal = await matchAnimal(c, g.animal);
    const flags = [...g.flags, ...(g.is_pet_document ? [] : ['NOT_PET_DOCUMENT']), ...(animal === null ? ['NEEDS_ANIMAL'] : []), ...(g.dropped ? ['VALUES_DROPPED'] : [])];
    await c.query(
      `UPDATE ingest.inbox_item SET status = 'NEEDS_REVIEW', animal_proposed_id = $2, doc_kind_proposed = $3, document_date = COALESCE($4::date, document_date, $5::date),
              document_date_assumed = ($4::date IS NULL), found = $6, dropped_count = dropped_count + $7,
              flags = (SELECT coalesce(array_agg(DISTINCT x), '{}') FROM unnest(flags || $8::text[]) x), updated_at = now()
        WHERE inbox_item_id = $1`,
      [item.id, animal, g.doc_kind, g.document_date, item.discovered_at, JSON.stringify(g.found), g.dropped, flags],
    );
    if (g.document_date) await c.query('UPDATE ingest.source_document SET document_date = $2, doc_kind = $3 WHERE source_document_id = $1', [item.doc, g.document_date, g.doc_kind]);
    return true;
  });
  return kept ? 'ASSESSED' : 'SKIPPED';
}

export interface SweepReport { workspace_id: number; discovered: number; read: number; assessed: number; waiting: number; failed: number; filed: number }
const busy = new Set<number>();

/** One pass over one household: scan every folder with a go-ahead, read, assess, finish any filing left half-done. */
export async function sweepWorkspace(ws: number, deps: InboxDeps): Promise<SweepReport | null> {
  if (busy.has(ws)) return null; // one pass at a time per household (the 60 s tick and an upload can overlap)
  busy.add(ws);
  try {
    const rep: SweepReport = { workspace_id: ws, discovered: 0, read: 0, assessed: 0, waiting: 0, failed: 0, filed: 0 };
    const bindings = await withTxn(null, true, async (c) => (await c.query<Binding & { workspace_id: string }>(
      'SELECT workspace_id::text, member_name, vault_folder_name, go_ahead_at::text, ai_go_ahead_at::text FROM core.vault_folder_binding WHERE workspace_id = $1 AND go_ahead_at IS NOT NULL ORDER BY binding_id', [ws])).rows);
    for (const b of bindings) rep.discovered += (await scanFolder(ws, deps, { ...b, workspace_id: ws })).discovered;
    // filing a document a person already checked is not reading it, so FILED_PENDING is finished whatever the go-ahead
    const items = await withTxn(ws, true, async (c) => (await c.query<Item>(
      `${ITEM_SQL} WHERE (i.status = 'DISCOVERED' AND ${GO_AHEAD}) OR i.status = 'FILED_PENDING' ORDER BY i.inbox_item_id`)).rows);
    for (const it of items.filter((x) => x.status === 'DISCOVERED')) if (await readText(ws, deps, it)) rep.read++;
    const toAssess = await withTxn(ws, true, async (c) => (await c.query<Item>(`${ITEM_SQL} WHERE i.status = 'READ' AND ${GO_AHEAD} ORDER BY i.inbox_item_id`)).rows);
    for (const it of toAssess) {
      const r = await assess(ws, deps, it);
      if (r === 'ASSESSED') rep.assessed++;
      else if (r === 'WAITING') rep.waiting++;
      else if (r === 'FAILED') rep.failed++;
    }
    for (const it of items.filter((x) => x.status === 'FILED_PENDING')) if (await finishFiling(ws, deps, it.id)) rep.filed++;
    return rep;
  } finally {
    busy.delete(ws);
  }
}

/** Every household with at least one folder someone has said yes to. (The binding table has no RLS: see migration 011.) */
export async function workspacesToSweep(): Promise<number[]> {
  return withTxn(null, true, async (c) => (await c.query<{ ws: string }>('SELECT DISTINCT workspace_id::text AS ws FROM core.vault_folder_binding WHERE go_ahead_at IS NOT NULL ORDER BY 1')).rows.map((x) => toId(x.ws)));
}

// ======================================================================== add a document (the Add button)

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
/** First bytes must match what the name says, for the binary kinds. Pure. */
export function contentMatches(name: string, buf: Buffer): boolean {
  const ext = extname(name).toLowerCase();
  if (ext === '.pdf') return buf.subarray(0, 5).toString('latin1') === '%PDF-';
  if (ext === '.jpg' || ext === '.jpeg') return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (ext === '.png') return buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === '.docx') return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
  return !buf.includes(0); // .txt / .md: text
}

/** Writes the file into the caller's own Pets inbox (never overwriting), then nudges a sweep. (Vitalis capturephoto.ts.) */
export async function addDocument(ws: number, member: string, body: Record<string, unknown>, deps: InboxDeps): Promise<{ saved: true; file_name: string; reading: boolean }> {
  const b = await withTxn(ws, true, async (c) => {
    await requireAny(c, member, 'DROP_DOCUMENTS', 'a Viewer cannot add documents');
    return bindingOf(c, ws, member);
  });
  if (!b) throw conflict('set up your Pets folder first (Inbox)');
  const name = safeFileName(body.file_name);
  if (!name) throw bad('send a PDF, a photo (JPEG or PNG), a Word file (.docx) or a text file');
  const b64 = typeof body.data_base64 === 'string' ? body.data_base64.replace(/^data:[^,]*,/, '') : '';
  if (!b64) throw bad('the file is empty');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > MAX_UPLOAD_BYTES) throw bad('that file is larger than 15 MB');
  if (!contentMatches(name, buf)) throw bad('that file is not what its name says');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const rel = `${b.vault_folder_name}/${INBOX_SUB}/${stamp}-${name}`;
  const abs = await resolveInside(deps.root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, buf, { flag: 'wx', mode: 0o600 });
  if (b.go_ahead_at) void sweepWorkspace(ws, deps).catch(() => undefined); // the 60 s sweep would find it anyway
  return { saved: true, file_name: basename(rel), reading: !!b.go_ahead_at };
}

// ======================================================================== reads

/** Who may see an item: with an animal decided, SEE_DOCUMENTS on it; before that, the person whose folder it is, or an
 *  Owner / Primary carer of any animal (the people who will confirm it). */
async function maySee(c: Client, member: string, it: { member_name: string; animal_id: number | null }): Promise<boolean> {
  if (it.animal_id !== null) {
    try { return can(await roleOn(c, it.animal_id, member), 'SEE_DOCUMENTS'); } catch { return false; }
  }
  return it.member_name === member || (await managesAny(c, member));
}
/** Who may do step 1 on an item: its folder's person; else an Owner / Primary carer (of its animal, once it has one). */
async function mayDecide(c: Client, member: string, it: { member_name: string; animal_id: number | null }): Promise<boolean> {
  if (it.member_name === member) return true;
  if (it.animal_id !== null) {
    try { return can(await roleOn(c, it.animal_id, member), 'CONFIRM_RECORDS'); } catch { return false; }
  }
  return managesAny(c, member);
}
/** A by-id inbox route for someone who may not see the item answers exactly as for an id that does not exist: 404, with
 *  nothing about the document in it (independent review, finding 2). Used by every by-id inbox function and route guard. */
const NO_SUCH_ITEM = 'no such document in the inbox';
async function mustSee(c: Client, member: string, it: { member_name: string; animal_id: number | null }): Promise<void> {
  if (!(await maySee(c, member, it))) throw notFound(NO_SUCH_ITEM);
}
export async function requireSeeItem(c: Client, id: number, member: string): Promise<void> {
  await mustSee(c, member, await itemAnimal(c, id));
}

export interface InboxRow { id: number; file_name: string; status: string; flags: string[]; member_name: string; animal_id: number | null; animal_proposed_id: number | null; doc_kind: string | null; doc_kind_proposed: string | null; document_date: string | null; dropped_count: number; proposals: number; discovered_at: string; filed_at: string | null }
const ROW_COLS = `i.inbox_item_id::int AS id, d.file_name, i.status, i.flags, i.member_name, i.animal_id::int AS animal_id, i.animal_proposed_id::int AS animal_proposed_id,
                  i.doc_kind, i.doc_kind_proposed, i.document_date::text AS document_date, i.dropped_count, d.discovered_at::text AS discovered_at, i.filed_at::text AS filed_at,
                  (SELECT count(*)::int FROM ingest.proposal p WHERE p.inbox_item_id = i.inbox_item_id) AS proposals`;
const FROM = 'FROM ingest.inbox_item i JOIN ingest.source_document d ON d.workspace_id = i.workspace_id AND d.source_document_id = i.source_document_id';

export const WAITING = ['DISCOVERED', 'READ', 'ASSESSED', 'NEEDS_REVIEW', 'ASSESS_FAILED', 'FILED_PENDING'];
export async function listItems(c: Client, member: string): Promise<{ waiting: InboxRow[]; recent: InboxRow[] }> {
  const r = await c.query<InboxRow>(`SELECT ${ROW_COLS} ${FROM} WHERE i.status = ANY($1::text[]) OR i.updated_at > now() - interval '30 days' ORDER BY i.inbox_item_id DESC LIMIT 300`, [WAITING]);
  const seen: InboxRow[] = [];
  for (const x of r.rows) if (await maySee(c, member, x)) seen.push(x);
  return { waiting: seen.filter((x) => WAITING.includes(x.status)), recent: seen.filter((x) => !WAITING.includes(x.status)).slice(0, 20) };
}
/** "2 documents to check" on Home. */
export async function waitingCount(c: Client, member: string): Promise<number> {
  return (await listItems(c, member)).waiting.filter((x) => x.status === 'NEEDS_REVIEW' || x.status === 'ASSESS_FAILED' || x.flags.includes('AWAITING_AI_GO_AHEAD')).length;
}

export interface ProposalView { id: number; target: string; payload: Record<string, unknown>; corrected: Record<string, unknown> | null; page: number; quote: string; flags: string[]; status: string; decided_by: string | null; created_table: string | null; created_row_id: number | null }
type Loaded = InboxRow & { doc: number; vault_path: string; found: Record<string, unknown>; document_date_assumed: boolean; decided_by: string | null; filed_path: string | null };
async function loadItem(c: Client, id: number, lock = false): Promise<Loaded> {
  const r = await c.query<Loaded>(
    `SELECT ${ROW_COLS}, d.source_document_id::int AS doc, d.vault_path, i.found, i.document_date_assumed, i.decided_by, i.filed_path ${FROM} WHERE i.inbox_item_id = $1${lock ? ' FOR UPDATE OF i' : ''}`, [id]);
  if (!r.rows[0]) throw notFound(NO_SUCH_ITEM);
  return r.rows[0];
}

export async function getItem(c: Client, id: number, member: string) {
  const it = await loadItem(c, id);
  await mustSee(c, member, it);
  const text = await latestPages(c, id);
  const props = await c.query<ProposalView>(
    `SELECT proposal_id::int AS id, target, payload, corrected, page, quote, flags, status, decided_by, created_table, created_row_id::int AS created_row_id
       FROM ingest.proposal WHERE inbox_item_id = $1 ORDER BY CASE target WHEN 'contact' THEN 0 WHEN 'vet_visit' THEN 1 ELSE 2 END, proposal_id`, [id]);
  const runs = await c.query<{ method: string; status: string; model: string | null; dropped: number; at: string }>(
    'SELECT method, status, model, dropped, at::text FROM ingest.extraction_run WHERE inbox_item_id = $1 ORDER BY extraction_run_id', [id]);
  const animal = it.animal_id ?? it.animal_proposed_id;
  const role: Role | null = animal === null ? null : await roleOn(c, animal, member).catch(() => null);
  const { vault_path: _v, doc, ...rest } = it;
  void _v;
  return {
    ...rest, document_id: doc, pages: text?.pages ?? [], read_by: text?.method ?? null, proposals: props.rows, runs: runs.rows,
    my_role: role, can_confirm: role !== null && can(role, 'CONFIRM_RECORDS'),
  };
}

/** The original file, for "open the page" (sec 4.4): only to someone who may see its documents. */
export async function documentFile(c: Client, docId: number, member: string): Promise<{ vault_path: string; file_name: string; media_type: string }> {
  const r = await c.query<{ vault_path: string; file_name: string; media_type: string; member_name: string | null; animal_id: number | null }>(
    `SELECT d.vault_path, d.file_name, d.media_type, i.member_name, i.animal_id::int AS animal_id
       FROM ingest.source_document d LEFT JOIN ingest.inbox_item i ON i.workspace_id = d.workspace_id AND i.source_document_id = d.source_document_id
      WHERE d.source_document_id = $1`, [docId]);
  const d = r.rows[0];
  if (!d) throw notFound('no such document');
  if (!(await maySee(c, member, { member_name: d.member_name ?? '', animal_id: d.animal_id }))) throw notFound('no such document');
  return d;
}

/** The animal an item is about (decided, else proposed), for route guards. */
export async function itemAnimal(c: Client, id: number): Promise<{ animal_id: number | null; member_name: string }> {
  const r = await c.query<{ animal_id: number | null; member_name: string }>('SELECT animal_id::int AS animal_id, member_name FROM ingest.inbox_item WHERE inbox_item_id = $1', [id]);
  if (!r.rows[0]) throw notFound(NO_SUCH_ITEM);
  return r.rows[0];
}

// ======================================================================== review, step 1: what is it?

const checkDecide = bodyChecker<{ action: 'PROCESS' | 'KEEP_ONLY' | 'NOT_PET'; animal_id?: number | null; doc_kind?: string | null; document_date?: string | null }>(S.object({
  action: S.oneOf(['PROCESS', 'KEEP_ONLY', 'NOT_PET']), animal_id: S.id(), doc_kind: { type: ['string', 'null'], enum: [...DOC_KINDS, null] }, document_date: S.date(),
}, ['action']));

const REVIEWABLE = ['NEEDS_REVIEW', 'ASSESS_FAILED', 'READ'];
export async function decide(c: Client, id: number, member: string, body: unknown, today = todayIso()) {
  const b = checkDecide(body);
  const it = await loadItem(c, id, true);
  await mustSee(c, member, it);
  if (!REVIEWABLE.includes(it.status)) throw conflict('this document has already been dealt with');
  // Step 1 (what is it, which animal, which date) is the folder's own person's, or an Owner / Primary carer's -- for an
  // item already about an animal, of THAT animal. A Family member who may see it can check values and file it (step 2),
  // but cannot re-run step 1 and move someone else's document onto another animal (re-review of the fixes).
  if (!(await mayDecide(c, member, it))) throw forbidden('only the person who added it, or an Owner / Primary carer, can say what it is');
  if (b.action === 'NOT_PET') {
    // Not a pet document: nothing is read from it and it is not moved (the person removes it from their folder).
    await c.query("UPDATE ingest.proposal SET status = 'DISMISSED', decided_by = $2, decided_at = now() WHERE inbox_item_id = $1 AND status = 'PROPOSED'", [id, member]);
    await c.query("UPDATE ingest.inbox_item SET status = 'IGNORED', decided_by = $2, decided_at = now(), updated_at = now() WHERE inbox_item_id = $1", [id, member]);
    return getItem(c, id, member);
  }
  if (!b.animal_id) throw bad('which animal is this about?');
  await requireOn(c, b.animal_id, member, 'DROP_DOCUMENTS');
  const kind = b.doc_kind ?? it.doc_kind ?? it.doc_kind_proposed;
  if (!kind) throw bad('what kind of document is it?');
  let date = it.document_date;
  if (b.document_date) {
    if (b.document_date > today) throw bad('a document date cannot be in the future');
    date = b.document_date;
  } else if (it.document_date_assumed || !date) throw bad('no date was printed on it: set the document date');
  else if (it.flags.includes('DATE_ORDER_AMBIGUOUS')) throw bad('the date could be day/month or month/day: set the document date');
  await c.query(
    `UPDATE ingest.inbox_item SET animal_id = $2, doc_kind = $3, document_date = $4::date, document_date_assumed = false, decided_by = $5, decided_at = now(),
            flags = array_remove(array_remove(array_remove(flags, 'NEEDS_ANIMAL'), 'DATE_ASSUMED'), 'DATE_ORDER_AMBIGUOUS'), updated_at = now() WHERE inbox_item_id = $1`,
    [id, b.animal_id, kind, date, member]);
  await flagUnusualWeights(c, id, b.animal_id, date ?? today);
  if (b.action === 'KEEP_ONLY') {
    await c.query("UPDATE ingest.proposal SET status = 'DISMISSED', decided_by = $2, decided_at = now() WHERE inbox_item_id = $1 AND status = 'PROPOSED'", [id, member]);
    await c.query("UPDATE ingest.inbox_item SET flags = array_append(flags, 'KEEP_ONLY') WHERE inbox_item_id = $1 AND NOT ('KEEP_ONLY' = ANY(flags))", [id]);
  }
  return getItem(c, id, member);
}

// ======================================================================== review, step 2: the values

const checkReview = bodyChecker<{ action: 'accept' | 'correct' | 'dismiss'; values?: Record<string, unknown>; confirm_unusual?: boolean }>(S.object({
  action: S.oneOf(['accept', 'correct', 'dismiss']), values: { type: 'object' }, confirm_unusual: { type: 'boolean' },
}, ['action']));

// ---- weights read from a document get the same plausibility question as a typed one (measurements.ts addMeasurement):
// an unusual weight is FLAGGED (UNUSUAL_WEIGHT), is never taken by "accept all", and is accepted only when the person
// answers the question with an explicit confirm_unusual -- recorded on the proposal as UNUSUAL_CONFIRMED with their name
// (decided_by). Only that answer ever sets plausibility_confirmed on the row (independent review, finding 5).
async function weightCheck(c: Client, animalId: number, v: Record<string, unknown>, docDate: string): Promise<Plausibility> {
  try {
    const on = str(v.on) ?? docDate;
    return plausibility(normalise('weight', v.value, v.unit), await previousReading(c, animalId, 'weight', on), await moduleOfAnimal(c, animalId));
  } catch {
    return { ok: false, question: 'That weight could not be checked: correct it or set it aside.', suggestion: null };
  }
}
/** Re-asks the question for every weight still waiting on this item (after step 1, and before "accept all"). */
async function flagUnusualWeights(c: Client, itemId: number, animalId: number, docDate: string): Promise<void> {
  const w = await c.query<{ id: number; payload: Record<string, unknown> }>("SELECT proposal_id::int AS id, payload FROM ingest.proposal WHERE inbox_item_id = $1 AND target = 'weight' AND status = 'PROPOSED'", [itemId]);
  for (const p of w.rows) {
    const ok = (await weightCheck(c, animalId, p.payload, docDate)).ok;
    await c.query(`UPDATE ingest.proposal SET flags = ${ok ? "array_remove(flags, 'UNUSUAL_WEIGHT')" : "array_append(array_remove(flags, 'UNUSUAL_WEIGHT'), 'UNUSUAL_WEIGHT')"} WHERE proposal_id = $1`, [p.id]);
  }
}

async function decidedItem(c: Client, id: number, member: string): Promise<Loaded> {
  const it = await loadItem(c, id, true);
  await mustSee(c, member, it);
  if (!REVIEWABLE.includes(it.status)) throw conflict('this document has already been dealt with');
  if (it.animal_id === null || !it.decided_by) throw conflict('first say what the document is (step 1)');
  await requireOn(c, it.animal_id, member, 'DROP_DOCUMENTS');
  return it;
}

export async function reviewProposal(c: Client, id: number, pid: number, member: string, body: unknown, today = todayIso()) {
  const b = checkReview(body);
  const it = await decidedItem(c, id, member);
  const p = await c.query<{ target: string; payload: Record<string, unknown> }>('SELECT target, payload FROM ingest.proposal WHERE proposal_id = $1 AND inbox_item_id = $2 FOR UPDATE', [pid, id]);
  if (!p.rows[0]) throw notFound('no such value on this document');
  let weightFlags: string | null = null;
  if (p.rows[0].target === 'weight' && b.action !== 'dismiss') {
    const v = b.action === 'correct' ? (b.values ?? {}) : p.rows[0].payload;
    const pl = await weightCheck(c, it.animal_id!, v, it.document_date ?? today);
    if (!pl.ok && b.confirm_unusual !== true) {
      // Nothing changes. The person answers "yes, that's right" (confirm_unusual) or corrects it -- as for a typed weight.
      throw conflict(pl.question, { needs_confirmation: true, question: pl.question, suggestion: pl.suggestion, proposal_id: pid });
    }
    weightFlags = pl.ok
      ? "array_remove(array_remove(flags, 'UNUSUAL_WEIGHT'), 'UNUSUAL_CONFIRMED')"
      : "array_append(array_remove(flags, 'UNUSUAL_CONFIRMED'), 'UNUSUAL_CONFIRMED')";
  }
  const setFlags = weightFlags ? `, flags = ${weightFlags}` : '';
  if (b.action === 'correct') {
    const target = p.rows[0].target;
    const values = Object.fromEntries(Object.entries(b.values ?? {}).filter(([, v]) => v !== null && v !== ''));
    const fits = target === 'contact'
      ? typeof values.name === 'string' && Object.keys(values).every((k) => k === 'name' || k === 'phone')
      : fieldsFit(target as FactKind, Object.fromEntries(Object.entries(values).filter(([k]) => k !== 'cost_amount' && k !== 'cost_currency')));
    if (!fits) throw bad('those values do not fit this kind of entry');
    await c.query(`UPDATE ingest.proposal SET status = 'CORRECTED', corrected = $3, decided_by = $2, decided_at = now()${setFlags} WHERE proposal_id = $1`, [pid, member, JSON.stringify(values)]);
  } else {
    await c.query(`UPDATE ingest.proposal SET status = $3, corrected = NULL, decided_by = $2, decided_at = now()${setFlags} WHERE proposal_id = $1`, [pid, member, b.action === 'accept' ? 'ACCEPTED' : 'DISMISSED']);
  }
  return getItem(c, id, member);
}

/** "Accept all that passed checks": every value still waiting that carries no warning flag. */
export async function acceptAllClean(c: Client, id: number, member: string, today = todayIso()) {
  const it = await decidedItem(c, id, member);
  await flagUnusualWeights(c, id, it.animal_id!, it.document_date ?? today); // an unusual weight is never accepted in bulk
  await c.query("UPDATE ingest.proposal SET status = 'ACCEPTED', decided_by = $2, decided_at = now() WHERE inbox_item_id = $1 AND status = 'PROPOSED' AND cardinality(flags) = 0", [id, member]);
  return getItem(c, id, member);
}

// ======================================================================== file: commit the rows, THEN move the original

const docProvenance = (doc: number, page: number, quote: string, member: string, corrected: boolean) => ({
  status: 'PROPOSED', source_class: 'VET_RECORD', channel: 'DOCUMENT', source_document_id: doc, source_page: page, source_quote: quote.slice(0, 400),
  // a value the person corrected is theirs (MANUAL); one accepted as read stays LLM_PROPOSAL, which the DB only lets in as PROPOSED
  extraction_method: corrected ? 'MANUAL' : 'LLM_PROPOSAL', proposed_by: corrected ? member : READER_NAME,
});
const REQUIRED_DATE: Partial<Record<Kind, string>> = { vet_visit: 'visit_on', vaccination: 'given_on', treatment: 'given_on', procedure: 'performed_on', lab_result: 'sampled_on' };
const str = (v: unknown): string | null => (typeof v === 'string' ? (v === '' ? null : v) : typeof v === 'number' ? String(v) : null);

/** Writes the accepted values as rows, in the caller's transaction. Returns how many rows were written. */
async function writeFacts(c: Client, ws: number, it: Loaded, member: string, role: Role, today: string): Promise<number> {
  const confirm = can(role, 'CONFIRM_RECORDS');
  const animalId = it.animal_id!;
  const docDate = it.document_date ?? today;
  const props = (await c.query<ProposalView>(
    `SELECT proposal_id::int AS id, target, payload, corrected, page, quote, flags, status FROM ingest.proposal
      WHERE inbox_item_id = $1 AND status IN ('ACCEPTED','CORRECTED') ORDER BY CASE target WHEN 'contact' THEN 0 WHEN 'vet_visit' THEN 1 ELSE 2 END, proposal_id`, [it.id])).rows;
  let contactId: number | null = null;
  let visitId: number | null = null;
  let n = 0;
  const done = async (pid: number, table: string, row: number) => {
    await c.query('UPDATE ingest.proposal SET created_table = $2, created_row_id = $3 WHERE proposal_id = $1', [pid, table, row]);
    n++;
  };
  // Owner / Primary carer: the person filing confirms (sec 4.3). Family member: the rows stay PROPOSED for them (sec 7.2).
  const promote = async (table: string, pk: string, row: number) => {
    if (confirm) await c.query(`UPDATE ${table} SET status = 'CONFIRMED', confirmed_by = $2, confirmed_at = now() WHERE ${pk} = $1`, [row, member]);
  };
  for (const p of props) {
    const v: Record<string, unknown> = { ...(p.corrected ?? p.payload) };
    const prov = docProvenance(it.doc, p.page, p.quote, member, p.status === 'CORRECTED');
    if (p.target === 'contact') {
      const name = typeof v.name === 'string' ? v.name.trim() : '';
      const hit = await c.query<{ id: string }>('SELECT contact_id::text AS id FROM core.contact WHERE lower(name) = lower($1) AND retired_at IS NULL ORDER BY contact_id LIMIT 1', [name]);
      if (hit.rows[0]) contactId = toId(hit.rows[0].id);
      else if (name && (await managesAny(c, member))) {
        contactId = await insertRow(c, 'core.contact', 'contact_id', { workspace_id: ws, kind: 'VET_PRACTICE', name: name.slice(0, 120), phone: str(v.phone), created_by: member });
      }
      if (contactId !== null) await done(p.id, 'core.contact', contactId);
      continue;
    }
    if (p.target === 'weight') {
      const on = str(v.on) ?? docDate;
      const nrm = normalise('weight', v.value, v.unit);
      const pl = await weightCheck(c, animalId, v, docDate);
      // the confirmed flag is the person's own answer, never set because the check failed
      const answered = p.flags.includes('UNUSUAL_CONFIRMED');
      if (!pl.ok && !answered) throw conflict(pl.question, { needs_confirmation: true, question: pl.question, suggestion: pl.suggestion, proposal_id: p.id });
      const row = await insertRow(c, 'health.measurement', 'measurement_id', {
        workspace_id: ws, animal_id: animalId, measure: 'weight', value: nrm.value.toString(), unit: nrm.unit, value_as_entered: nrm.entered.value.toString(), unit_as_entered: nrm.entered.unit,
        observed_at: middayOf(on), time_precision: 'DAY', plausibility_confirmed: !pl.ok && answered, created_by: member, ...prov,
      });
      await promote('health.measurement', 'measurement_id', row);
      await done(p.id, 'health.measurement', row);
      continue;
    }
    if (p.target === 'medication') {
      const med = await insertRow(c, 'health.medication', 'medication_id', {
        workspace_id: ws, animal_id: animalId, product_name: String(v.product_name).slice(0, 120), strength: str(v.strength), form: str(v.form), created_by: member,
      });
      const amount = str(v.dose_amount);
      const unit = str(v.dose_unit);
      const row = await insertRow(c, 'health.medication_event', 'medication_event_id', {
        workspace_id: ws, animal_id: animalId, medication_id: med, event_kind: 'PRESCRIBED', event_on: str(v.event_on) ?? docDate, event_precision: 'DAY',
        dose_text: str(v.dose_text), dose_amount: amount && unit ? amount : null, dose_unit: amount && unit ? unit : null, frequency: str(v.frequency),
        instructions_verbatim: str(v.instructions_verbatim), quantity_supplied: str(v.quantity_supplied), vet_visit_id: visitId, created_by: member, ...prov,
      });
      await promote('health.medication_event', 'medication_event_id', row);
      await done(p.id, 'health.medication_event', row);
      continue;
    }
    // the vet record kinds: the same registry and rules as a hand-typed record (records.ts)
    const kind = p.target as Kind;
    const def = KINDS[kind];
    const body: Record<string, unknown> = {};
    for (const k of Object.keys(def.fields)) if (v[k] !== undefined && v[k] !== null && v[k] !== '') body[k] = v[k];
    if (kind === 'vet_visit') {
      if (v.cost_amount !== undefined && v.cost_amount !== null) { body.cost_amount = v.cost_amount; body.cost_currency = v.cost_currency ?? 'EUR'; }
      if (contactId !== null) body.contact_id = contactId;
    } else if ('vet_visit_id' in def.fields && visitId !== null) body.vet_visit_id = visitId;
    const need = REQUIRED_DATE[kind];
    if (need && !body[need]) body[need] = docDate;
    const { cols } = await recordColumns(c, kind, animalId, body, today);
    const row = await insertRow(c, def.table, def.pk, { workspace_id: ws, animal_id: animalId, ...cols, created_by: member, ...prov });
    await promote(def.table, def.pk, row);
    if (kind === 'vet_visit' && visitId === null) visitId = row;
    await done(p.id, def.table, row);
  }
  return n;
}

/**
 * File the document (sec 5.2 "Confirm" + "File"). In ONE transaction: the accepted values become rows, the item becomes
 * FILED_PENDING with its destination. Only after that commit is the original moved; then FILED. If the move fails the
 * item stays FILED_PENDING (the rows are safe) and the sweep tries the move again.
 */
export async function fileItem(ws: number, deps: InboxDeps, id: number, member: string, today = todayIso()) {
  const asked = await withTxn(ws, false, async (c) => {
    const it = await decidedItem(c, id, member);
    const role = await requireOn(c, it.animal_id!, member, 'DROP_DOCUMENTS');
    const open = await c.query("SELECT 1 FROM ingest.proposal WHERE inbox_item_id = $1 AND status = 'PROPOSED' LIMIT 1", [id]);
    if (open.rowCount) throw conflict('some values are still waiting: accept, correct or dismiss each one');
    // A weight accepted earlier may have become unusual since (a newer reading was added): back to waiting, flagged,
    // so the person is asked -- committed, then refused below. Nothing is filed.
    const ws_ = await c.query<{ id: number; payload: Record<string, unknown>; corrected: Record<string, unknown> | null; flags: string[] }>(
      "SELECT proposal_id::int AS id, payload, corrected, flags FROM ingest.proposal WHERE inbox_item_id = $1 AND target = 'weight' AND status IN ('ACCEPTED','CORRECTED')", [id]);
    let n = 0;
    for (const w of ws_.rows) {
      if (w.flags.includes('UNUSUAL_CONFIRMED') || (await weightCheck(c, it.animal_id!, w.corrected ?? w.payload, it.document_date ?? today)).ok) continue;
      await c.query("UPDATE ingest.proposal SET status = 'PROPOSED', decided_by = NULL, decided_at = NULL, flags = array_append(array_remove(flags, 'UNUSUAL_WEIGHT'), 'UNUSUAL_WEIGHT') WHERE proposal_id = $1", [w.id]);
      n++;
    }
    if (n) return true;
    await writeFacts(c, ws, it, member, role, today);
    const b = await bindingOf(c, ws, it.member_name);
    if (!b) throw conflict('the folder this document came from is no longer set up');
    const dest = filedPath(b.vault_folder_name, it.doc_kind ?? 'OTHER', it.file_name);
    await c.query("UPDATE ingest.inbox_item SET status = 'FILED_PENDING', filed_by = $2, filed_at = now(), filed_path = $3, updated_at = now() WHERE inbox_item_id = $1", [id, member, dest]);
    return false;
  });
  if (asked) throw conflict('a weight is very different from the last one: check it again before filing');
  await finishFiling(ws, deps, id);
  return withTxn(ws, true, (c) => getItem(c, id, member));
}

/** FILED_PENDING -> FILED: move the original (never overwriting), then record where it is. Returns true when filed.
 *  When the name is taken in the filed folder it is filed under a suffixed name (-<hash8>, then -<hash8>-2 ... -9),
 *  recorded on the item (FILED_UNDER_NEW_NAME + filed_path). Any other failure flags MOVE_FAILED and the sweep tries
 *  again every pass; the rows are already safe (independent review, finding 9). */
export async function finishFiling(ws: number, deps: InboxDeps, id: number): Promise<boolean> {
  const it = await withTxn(ws, true, (c) => loadItem(c, id));
  if (it.status !== 'FILED_PENDING' || !it.filed_path) return false;
  const hash = (await withTxn(ws, true, (c) => c.query<{ h: string }>('SELECT file_hash AS h FROM ingest.source_document WHERE source_document_id = $1', [it.doc]))).rows[0]!.h;
  const ext = extname(it.filed_path);
  const stem = it.filed_path.slice(0, it.filed_path.length - ext.length);
  const candidates = [it.filed_path, `${stem}-${hash.slice(0, 8)}${ext}`, ...[2, 3, 4, 5, 6, 7, 8, 9].map((k) => `${stem}-${hash.slice(0, 8)}-${k}${ext}`)];
  let dest: string | null = null;
  try {
    for (const cand of candidates) {
      if (await fileExists(await resolveInside(deps.root, cand))) continue;
      try {
        await safeMove(deps.root, it.vault_path, cand);
        dest = cand;
        break;
      } catch (e) {
        if (e instanceof PetopiaError && e.status === 409 && /already filed there/.test(e.message)) continue; // taken meanwhile: next name
        throw e;
      }
    }
    if (dest === null) throw new Error('MOVE_NO_FREE_NAME');
  } catch {
    await withTxn(ws, false, (c) => c.query("UPDATE ingest.inbox_item SET flags = array_append(flags, 'MOVE_FAILED'), updated_at = now() WHERE inbox_item_id = $1 AND NOT ('MOVE_FAILED' = ANY(flags))", [id]));
    return false;
  }
  const renamed = dest !== it.filed_path;
  await withTxn(ws, false, async (c) => {
    await c.query('UPDATE ingest.source_document SET vault_path = $2 WHERE source_document_id = $1', [it.doc, dest]);
    await c.query(
      `UPDATE ingest.inbox_item SET status = 'FILED', filed_path = $2, flags = ${renamed ? "array_append(array_remove(array_remove(flags, 'MOVE_FAILED'), 'FILED_UNDER_NEW_NAME'), 'FILED_UNDER_NEW_NAME')" : "array_remove(flags, 'MOVE_FAILED')"},
              updated_at = now() WHERE inbox_item_id = $1`, [id, dest]);
  });
  return true;
}

/** "Try reading it again" after a failed reader run: back to READ, so the next sweep (with the reader the person allows) tries once more. */
export async function retryRead(c: Client, id: number, member: string) {
  const it = await loadItem(c, id, true);
  await mustSee(c, member, it);
  if (it.status !== 'ASSESS_FAILED' && !(it.status === 'READ' && it.flags.includes('AWAITING_AI_GO_AHEAD'))) throw conflict('only a document that could not be read can be tried again');
  await c.query("UPDATE ingest.inbox_item SET status = 'READ', flags = array_remove(flags, 'AWAITING_AI_GO_AHEAD'), updated_at = now() WHERE inbox_item_id = $1", [id]);
  return getItem(c, id, member);
}
