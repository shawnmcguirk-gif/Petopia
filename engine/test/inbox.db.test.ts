// S5 inbox + AI reading with a database (A20, A21; spec sec 4, 5). Runs only with PETOPIA_TEST_DATABASE_URL. The vault
// is a temp folder; text extraction and the AI reader are FAKES injected through InboxDeps (the real claude -p, glm-ocr
// and PyMuPDF only run on the iMac). Fictional fixtures only: "Biscuit", a cat.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PageText, Extractor } from '../src/extract.js';
import type { Reader, ReaderAnswer } from '../src/reader.js';

const URL_ = process.env.PETOPIA_TEST_DATABASE_URL;
if (URL_) process.env.PETOPIA_DATABASE_URL = URL_;

const { grantHousehold, setAnimalRole } = await import('../src/access.js');
const { createAnimal } = await import('../src/animals.js');
const { closePool, withTxn } = await import('../src/db.js');
const inbox = await import('../src/inbox.js');
const { getTimeline } = await import('../src/timeline.js');

const run = `i${Date.now().toString(36)}`;
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

// ---- a fictional invoice; `ref` makes each copy a different file
const invoice = (ref: string, extra = '') => `Riverside Veterinary Clinic   Tel 01 555 0101
Invoice date: 03/10/2026   Ref ${ref}
Patient: Biscuit (feline)   Microchip: 900 000 000 000 001
Weight: 4.2 kg
Vaccination: Feline enteritis  next due 03/10/2027
Consultation  45.00
Vaccine  30.50
Total due: €75.50
${extra}`;
function answerFor(text: string, over: Partial<ReaderAnswer> = {}): ReaderAnswer {
  const ref = /Ref (\S+)/.exec(text)?.[1] ?? '';
  return {
    is_pet_document: true, doc_kind: 'INVOICE',
    animal: { name: 'Biscuit', species: 'cat', microchip: '900000000000001', page: 1, quote: 'Patient: Biscuit (feline)   Microchip: 900 000 000 000 001' },
    document_date: { value: '2026-10-03', page: 1, quote: `Invoice date: 03/10/2026   Ref ${ref}` },
    provider: { name: 'Riverside Veterinary Clinic', phone: '01 555 0101', page: 1, quote: 'Riverside Veterinary Clinic   Tel 01 555 0101' },
    facts: [
      { kind: 'vet_visit', page: 1, quote: 'Invoice date: 03/10/2026', fields: { visit_on: '2026-10-03', kind: 'ROUTINE' } },
      // the fake number: the page says 4.2 kg, the "model" says 61 -> the guard must drop it and count it
      { kind: 'weight', page: 1, quote: 'Weight: 4.2 kg', fields: { value: '61', unit: 'kg' } },
      { kind: 'vaccination', page: 1, quote: 'Vaccination: Feline enteritis  next due 03/10/2027', fields: { vaccine: 'Feline enteritis', given_on: '2026-10-03', next_due_on: '2027-10-03' } },
    ],
    costs: { currency: 'EUR', total: { amount: '75.50', page: 1, quote: 'Total due: €75.50' }, lines: [
      { description: 'Consultation', amount: '45.00', page: 1, quote: 'Consultation  45.00' }, { description: 'Vaccine', amount: '30.50', page: 1, quote: 'Vaccine  30.50' },
    ] },
    ...over,
  };
}

const calls = { claude: [] as PageText[][], local: [] as PageText[][] };
let claudeMode: 'ok' | 'throw' | 'garbage' = 'ok';
const claude: Reader = {
  kind: 'claude',
  read: (pages) => {
    calls.claude.push(pages);
    if (claudeMode === 'throw') return Promise.reject(new Error('READER_TIMEOUT'));
    if (claudeMode === 'garbage') return Promise.resolve({ output: { hello: 'world' }, model: 'fake', cli_version: null, usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0.01 } });
    const text = pages.map((p) => p.text).join('\n');
    const notPet = text.includes('Electricity bill');
    return Promise.resolve({ output: notPet ? answerFor(text, { is_pet_document: false, doc_kind: 'OTHER', facts: [] }) : answerFor(text), model: 'fake-sonnet', cli_version: '9.9.9 (fake)', usage: { input_tokens: 1200, output_tokens: 300, cost_usd: 0.02 } });
  },
};
const local: Reader = { kind: 'local', read: (pages) => { calls.local.push(pages); return Promise.resolve({ output: answerFor(pages[0]!.text), model: 'fake-local', cli_version: null, usage: { input_tokens: null, output_tokens: null, cost_usd: null } }); } };
// text files are their own text; a .png is "OCR'd" at home into text (the image is never handed to a reader)
const extractor: Extractor = {
  textPages: async (abs) => (abs.endsWith('.png') ? [{ page: 1, text: '' }] : [{ page: 1, text: await readFile(abs, 'utf8') }]),
  ocrPage: () => Promise.resolve(invoice('OCR-1')),
  ocrIdentity: () => Promise.resolve({ model_name: 'glm-ocr (fake)', model_digest: null }),
};

describe.skipIf(!URL_)('S5 inbox + AI reading (database)', () => {
  let A = 0;
  let cat = 0;
  let root = '';
  const alex = who('alex'); // Owner of Biscuit, household admin
  const sam = who('sam'); // Family (default)
  const kim = who('kim'); // Viewer
  const deps = () => ({ root, extractor, reader: claude, local: null });
  const inA = <X,>(fn: (c: import('../src/db.js').Client) => Promise<X>) => withTxn(A, false, fn);
  const folder = `Alex${run}`;
  const inboxDir = () => join(root, folder, 'Pets', 'inbox');
  const items = async () => (await withTxn(A, true, (c) => c.query<{ id: number; status: string; flags: string[]; dropped_count: number; animal_proposed_id: number | null; file: string }>(
    `SELECT i.inbox_item_id::int AS id, i.status, i.flags, i.dropped_count, i.animal_proposed_id::int AS animal_proposed_id, d.file_name AS file
       FROM ingest.inbox_item i JOIN ingest.source_document d ON d.source_document_id = i.source_document_id ORDER BY i.inbox_item_id`))).rows;
  const byFile = async (part: string) => (await items()).find((x) => x.file.includes(part))!;
  /** "Accept all that passed checks", then look at each flagged value and accept it too (as a person would, after reading the warning). */
  const acceptEverything = async (id: number, member: string) => {
    await inA((c) => inbox.acceptAllClean(c, id, member));
    const left = await withTxn(A, true, (c) => c.query<{ id: number; flags: string[] }>("SELECT proposal_id::int AS id, flags FROM ingest.proposal WHERE inbox_item_id = $1 AND status = 'PROPOSED'", [id]));
    expect(left.rows.every((p) => p.flags.length > 0)).toBe(true); // accept-all left only the flagged ones
    for (const p of left.rows) await inA((c) => inbox.reviewProposal(c, id, p.id, member, { action: 'accept' }));
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'petopia-vault-'));
    A = await newHousehold(alex);
    await inA(async (c) => { await grantHousehold(c, A, sam, alex, [alex]); await grantHousehold(c, A, kim, alex, [alex]); });
    cat = (await inA((c) => createAnimal(c, A, alex, { name: 'Biscuit', species: 'cat', born: '2018', microchip: '900000000000001' }, T))).id;
    await inA((c) => setAnimalRole(c, A, cat, kim, 'VIEWER', alex));
  });
  afterAll(async () => { await closePool(); await rm(root, { recursive: true, force: true }); });

  it('A20: a folder is read only after its own person says yes; nobody can say yes for someone else', async () => {
    await expect(inA((c) => inbox.setFolder(c, A, kim, {}))).rejects.toMatchObject({ status: 403 }); // a Viewer adds no documents
    const mine = await inA((c) => inbox.setFolder(c, A, alex, { folder }));
    expect(mine).toMatchObject({ folder, reading: false, ai_reading: false, inbox_path: `${folder}/Pets/inbox` });
    await mkdir(inboxDir(), { recursive: true });
    await writeFile(join(inboxDir(), 'first.txt'), invoice('R1'));
    expect(await inbox.workspacesToSweep()).not.toContain(A);
    expect(await inbox.sweepWorkspace(A, deps())).toMatchObject({ discovered: 0 });
    expect(await items()).toEqual([]);
    // the database refuses a go-ahead in anyone else's name, even written directly
    await expect(withTxn(null, false, (c) => c.query('UPDATE core.vault_folder_binding SET go_ahead_by = $2, go_ahead_at = now() WHERE member_name = $1', [alex, sam]))).rejects.toMatchObject({ code: '23514' });
    await expect(withTxn(null, false, (c) => c.query('UPDATE core.vault_folder_binding SET ai_go_ahead_by = $2, ai_go_ahead_at = now() WHERE member_name = $1', [alex, sam]))).rejects.toMatchObject({ code: '23514' });
  });

  it('A20: with only the folder go-ahead, text is read at home but never sent to Claude: the document waits', async () => {
    const r = await inA((c) => inbox.setConsent(c, A, alex, 'FOLDER_READ', true));
    expect(r).toMatchObject({ reading: true, ai_reading: false });
    const rep = await inbox.sweepWorkspace(A, deps());
    expect(rep).toMatchObject({ discovered: 1, read: 1, assessed: 0, waiting: 1 });
    expect(calls.claude).toHaveLength(0);
    expect(await byFile('first')).toMatchObject({ status: 'READ', flags: ['AWAITING_AI_GO_AHEAD'] });
    // the consent is recorded, with the words shown, and that record cannot be changed
    const ev = await withTxn(A, true, (c) => c.query<{ kind: string; given: boolean; words_shown: string }>('SELECT kind, given, words_shown FROM core.consent_event WHERE member_name = $1', [alex]));
    expect(ev.rows).toEqual([{ kind: 'FOLDER_READ', given: true, words_shown: inbox.folderWords(folder) }]);
    await expect(inA((c) => c.query('UPDATE core.consent_event SET given = false WHERE member_name = $1', [alex]))).rejects.toMatchObject({ code: '23514' });
  });

  it('Q4 fallback: without the AI go-ahead a configured local model reads it instead (Claude still never called)', async () => {
    const it0 = await byFile('first');
    const all = await withTxn(A, true, (c) => c.query<{ id: number; doc: number; member_name: string; status: string; vault_path: string; file_name: string; media_type: string; flags: string[]; discovered_at: string }>(
      `SELECT i.inbox_item_id::int AS id, d.source_document_id::int AS doc, i.member_name, i.status, d.vault_path, d.file_name, d.media_type, i.flags, d.discovered_at::date::text AS discovered_at
         FROM ingest.inbox_item i JOIN ingest.source_document d ON d.source_document_id = i.source_document_id WHERE i.inbox_item_id = $1`, [it0.id]));
    expect(await inbox.assess(A, { ...deps(), local }, all.rows[0]!)).toBe('ASSESSED');
    expect(calls.local).toHaveLength(1);
    expect(calls.claude).toHaveLength(0);
    const runs = await withTxn(A, true, (c) => c.query<{ method: string }>("SELECT method FROM ingest.extraction_run WHERE inbox_item_id = $1 AND method NOT IN ('TEXT_LAYER','OCR')", [it0.id]));
    expect(runs.rows.map((x) => x.method)).toEqual(['LOCAL_MODEL']);
  });

  it('A20: with the AI go-ahead, one call per document, TEXT only (a photo is OCR\'d at home); the fake number is dropped and counted', async () => {
    await inA((c) => inbox.setConsent(c, A, alex, 'AI_READING', true));
    await writeFile(join(inboxDir(), 'second.txt'), invoice('R2'));
    await writeFile(join(inboxDir(), 'snap.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    const rep = await inbox.sweepWorkspace(A, deps());
    expect(rep).toMatchObject({ discovered: 2, read: 2, assessed: 2 });
    expect(calls.claude).toHaveLength(2);
    expect(calls.claude[0]).toEqual([{ page: 1, text: invoice('R2') }]);
    expect(calls.claude[1]).toEqual([{ page: 1, text: invoice('OCR-1') }]); // what glm-ocr read, never the PNG
    const second = await byFile('second');
    expect(second).toMatchObject({ status: 'NEEDS_REVIEW', dropped_count: 1, animal_proposed_id: cat });
    expect(second.flags).toContain('VALUES_DROPPED');
    const props = await withTxn(A, true, (c) => c.query<{ target: string }>('SELECT target FROM ingest.proposal WHERE inbox_item_id = $1 ORDER BY proposal_id', [second.id]));
    expect(props.rows.map((x) => x.target)).toEqual(['contact', 'vet_visit', 'vaccination']); // no 61 kg weight
    const run = await withTxn(A, true, (c) => c.query("SELECT method, model, cli_version, dropped, errors, input_tokens FROM ingest.extraction_run WHERE inbox_item_id = $1 AND method = 'LLM_PROPOSAL'", [second.id]));
    expect(run.rows[0]).toMatchObject({ method: 'LLM_PROPOSAL', model: 'fake-sonnet', cli_version: '9.9.9 (fake)', dropped: 1, errors: 'NUMBER_NOT_IN_QUOTE', input_tokens: 1200 });
    // nothing is authoritative yet: no vet record exists for Biscuit
    const n = await withTxn(A, true, (c) => c.query<{ n: number }>('SELECT ((SELECT count(*) FROM health.vaccination) + (SELECT count(*) FROM health.vet_visit) + (SELECT count(*) FROM health.measurement))::int AS n'));
    expect(n.rows[0]!.n).toBe(0);
  });

  it('A21: two steps -- values cannot be judged before "what is it?"; a Viewer cannot do either', async () => {
    const it2 = await byFile('second');
    const pid = (await withTxn(A, true, (c) => c.query<{ id: number }>("SELECT proposal_id::int AS id FROM ingest.proposal WHERE inbox_item_id = $1 AND target = 'vaccination'", [it2.id]))).rows[0]!.id;
    await expect(inA((c) => inbox.reviewProposal(c, it2.id, pid, alex, { action: 'accept' }))).rejects.toMatchObject({ status: 409 });
    await expect(inA((c) => inbox.decide(c, it2.id, kim, { action: 'PROCESS', animal_id: cat }))).rejects.toMatchObject({ status: 403 });
    await expect(inA((c) => inbox.getItem(c, it2.id, kim))).rejects.toMatchObject({ status: 403 }); // before an animal is set, only its person or a manager
    const view = await inA((c) => inbox.decide(c, it2.id, alex, { action: 'PROCESS', animal_id: cat, doc_kind: 'INVOICE' }, T));
    expect(view).toMatchObject({ animal_id: cat, doc_kind: 'INVOICE', document_date: '2026-10-03' });
    await expect(inbox.fileItem(A, deps(), it2.id, alex, T)).rejects.toMatchObject({ status: 409 }); // values still waiting
    await expect(inA((c) => inbox.reviewProposal(c, it2.id, pid, alex, { action: 'correct', values: { vaccine: 'Feline enteritis', diagnosis: 'x' } }))).rejects.toMatchObject({ status: 400 });
    await inA((c) => inbox.reviewProposal(c, it2.id, pid, alex, { action: 'correct', values: { vaccine: 'Feline enteritis (RCP)', given_on: '2026-10-03', next_due_on: '2027-10-03' } }));
    await inA((c) => inbox.acceptAllClean(c, it2.id, alex));
  });

  it('A21: filing writes confirmed rows with their page and quote in one go, THEN moves the original (hash unchanged)', async () => {
    const it2 = await byFile('second');
    const src = (await readdir(inboxDir())).find((f) => f === 'second.txt')!;
    const hashBefore = createHash('sha256').update(await readFile(join(inboxDir(), src))).digest('hex');
    const out = await inbox.fileItem(A, deps(), it2.id, alex, T);
    expect(out.status).toBe('FILED');
    expect(out.filed_path).toBe(`${folder}/Pets/filed/invoice/second.txt`);
    expect(await readdir(inboxDir())).not.toContain('second.txt');
    const moved = await readFile(join(root, folder, 'Pets', 'filed', 'invoice', 'second.txt'));
    expect(createHash('sha256').update(moved).digest('hex')).toBe(hashBefore);
    const doc = await withTxn(A, true, (c) => c.query<{ vault_path: string; file_hash: string }>('SELECT vault_path, file_hash FROM ingest.source_document WHERE source_document_id = $1', [out.document_id]));
    expect(doc.rows[0]).toEqual({ vault_path: out.filed_path, file_hash: hashBefore });
    const visit = await withTxn(A, true, (c) => c.query<{ id: number }>('SELECT vet_visit_id::int AS id, status, confirmed_by, channel, source_page, extraction_method, proposed_by, cost_amount::text, contact_id IS NOT NULL AS has_clinic FROM health.vet_visit WHERE animal_id = $1', [cat]));
    expect(visit.rows.map((r) => ({ ...r, id: typeof r.id }))).toEqual([{ id: 'number', status: 'CONFIRMED', confirmed_by: alex, channel: 'DOCUMENT', source_page: 1, extraction_method: 'LLM_PROPOSAL', proposed_by: 'petopia-reader', cost_amount: '75.50', has_clinic: true }]);
    const vac = await withTxn(A, true, (c) => c.query('SELECT vaccine, status, extraction_method, proposed_by, source_quote, vet_visit_id::int AS visit FROM health.vaccination WHERE animal_id = $1', [cat]));
    expect(vac.rows).toEqual([{ vaccine: 'Feline enteritis (RCP)', status: 'CONFIRMED', extraction_method: 'MANUAL', proposed_by: alex, source_quote: 'Vaccination: Feline enteritis  next due 03/10/2027', visit: visit.rows[0]!.id }]);
    const tl = await withTxn(A, true, (c) => getTimeline(c, cat, alex));
    expect(tl.filter((e) => e.source?.document_id === out.document_id && e.source.page === 1).map((e) => e.kind).sort()).toEqual(['VACCINATION', 'VET_VISIT']);
    // the original is shown only to someone who may see documents
    expect(await withTxn(A, true, (c) => inbox.documentFile(c, out.document_id, sam))).toMatchObject({ vault_path: out.filed_path });
    await expect(withTxn(A, true, (c) => inbox.documentFile(c, out.document_id, kim))).rejects.toMatchObject({ status: 403 });
  });

  it('A21 + sec 7.2: a Family member can file, but what they file waits as PROPOSED for an Owner / Primary carer', async () => {
    const img = await byFile('snap');
    await inA((c) => inbox.decide(c, img.id, sam, { action: 'PROCESS', animal_id: cat, doc_kind: 'INVOICE' }, T));
    await acceptEverything(img.id, sam);
    const out = await inbox.fileItem(A, deps(), img.id, sam, T);
    expect(out.status).toBe('FILED');
    const rows = await withTxn(A, true, (c) => c.query<{ status: string }>('SELECT status FROM health.vet_visit WHERE source_document_id = $1', [out.document_id]));
    expect(rows.rows).toEqual([{ status: 'PROPOSED' }]);
  });

  it('a failed move leaves the rows committed and the item FILED_PENDING; the sweep finishes it later', async () => {
    const first = await byFile('first');
    await inA((c) => inbox.decide(c, first.id, alex, { action: 'PROCESS', animal_id: cat, doc_kind: 'LAB_REPORT' }, T));
    await acceptEverything(first.id, alex);
    await mkdir(join(root, folder, 'Pets', 'filed'), { recursive: true });
    await writeFile(join(root, folder, 'Pets', 'filed', 'lab_report'), 'in the way'); // a FILE where the folder should go
    const out = await inbox.fileItem(A, deps(), first.id, alex, T);
    expect(out.status).toBe('FILED_PENDING');
    expect(out.flags).toContain('MOVE_FAILED');
    expect((await withTxn(A, true, (c) => c.query('SELECT 1 FROM health.vet_visit WHERE source_document_id = $1', [out.document_id]))).rowCount).toBe(1);
    await rm(join(root, folder, 'Pets', 'filed', 'lab_report'));
    expect(await inbox.sweepWorkspace(A, deps())).toMatchObject({ filed: 1 });
    expect(await byFile('first')).toMatchObject({ status: 'FILED' });
  });

  it('the same file twice is one document, flagged as a possible duplicate', async () => {
    await writeFile(join(inboxDir(), 'copy-of-second.txt'), invoice('R2'));
    const before = (await items()).length;
    await inbox.sweepWorkspace(A, deps());
    expect((await items()).length).toBe(before);
    expect((await byFile('second')).flags).toContain('POSSIBLE_DUPLICATE');
  });

  it('a reader that fails or answers off-schema leaves "couldn\'t read" -- nothing guessed; it can be tried again', async () => {
    claudeMode = 'throw';
    await writeFile(join(inboxDir(), 'third.txt'), invoice('R3'));
    await inbox.sweepWorkspace(A, deps());
    expect(await byFile('third')).toMatchObject({ status: 'ASSESS_FAILED' });
    claudeMode = 'garbage';
    const thirdId = (await byFile('third')).id;
    await inA((c) => inbox.retryRead(c, thirdId, alex));
    await inbox.sweepWorkspace(A, deps());
    const t = await byFile('third');
    expect(t.status).toBe('ASSESS_FAILED');
    const r = await withTxn(A, true, (c) => c.query<{ status: string }>("SELECT status FROM ingest.extraction_run WHERE inbox_item_id = $1 AND method = 'LLM_PROPOSAL' ORDER BY extraction_run_id", [t.id]));
    expect(r.rows.map((x) => x.status)).toEqual(['FAILED', 'INVALID']);
    expect((await withTxn(A, true, (c) => c.query('SELECT 1 FROM ingest.proposal WHERE inbox_item_id = $1', [t.id]))).rowCount).toBe(0);
    claudeMode = 'ok';
  });

  it('"not a pet document" is set aside, not moved; "keep document only" files it with no values', async () => {
    await writeFile(join(inboxDir(), 'bill.txt'), 'Electricity bill\nTotal 99.00');
    await inbox.sweepWorkspace(A, deps());
    const bill = await byFile('bill');
    expect(bill.flags).toContain('NOT_PET_DOCUMENT');
    await inA((c) => inbox.decide(c, bill.id, alex, { action: 'NOT_PET' }));
    expect(await byFile('bill')).toMatchObject({ status: 'IGNORED' });
    expect(await readdir(inboxDir())).toContain('bill.txt');
    const third = await byFile('third');
    await inA((c) => inbox.decide(c, third.id, alex, { action: 'KEEP_ONLY', animal_id: cat, doc_kind: 'INVOICE', document_date: '2026-10-03' }, T));
    const out = await inbox.fileItem(A, deps(), third.id, alex, T);
    expect(out.status).toBe('FILED');
    expect((await withTxn(A, true, (c) => c.query('SELECT 1 FROM health.vet_visit WHERE source_document_id = $1', [out.document_id]))).rowCount).toBe(0);
  });

  it('the Add button writes into the caller\'s own inbox, never over a file, and refuses a Viewer and a mislabelled file', async () => {
    await expect(inbox.addDocument(A, kim, { file_name: 'x.txt', data_base64: Buffer.from('hi').toString('base64') }, deps())).rejects.toMatchObject({ status: 403 });
    await expect(inbox.addDocument(A, alex, { file_name: 'x.pdf', data_base64: Buffer.from('not a pdf').toString('base64') }, deps())).rejects.toMatchObject({ status: 400 });
    await expect(inbox.addDocument(A, alex, { file_name: '../../x.txt', data_base64: Buffer.from('hi').toString('base64') }, deps())).resolves.toMatchObject({ saved: true });
    const r = await inbox.addDocument(A, alex, { file_name: 'scan.pdf', data_base64: Buffer.from('%PDF-1.4\n').toString('base64') }, deps());
    expect(r.file_name).toMatch(/^\d{8}-\d{6}-scan\.pdf$/);
    expect(await readdir(inboxDir())).toContain(r.file_name);
    await expect(inbox.addDocument(A, sam, { file_name: 'x.txt', data_base64: Buffer.from('hi').toString('base64') }, deps())).rejects.toMatchObject({ status: 409 }); // no folder yet
  });

  it('withdrawing the AI go-ahead stops new documents going to Claude at once', async () => {
    await inA((c) => inbox.setConsent(c, A, alex, 'AI_READING', false));
    const n = calls.claude.length;
    await writeFile(join(inboxDir(), 'fourth.txt'), invoice('R4'));
    await new Promise((r) => setTimeout(r, 50)); // let any upload-triggered sweep finish first
    await inbox.sweepWorkspace(A, deps());
    expect(calls.claude.length).toBe(n);
    expect(await byFile('fourth')).toMatchObject({ status: 'READ', flags: ['AWAITING_AI_GO_AHEAD'] });
  });
});
