// Checking one document (spec sec 4.3, 5.2 "Review -- two steps"; S5, A21).
//   Step 1  What is it? -- which animal, what kind, what date (with what was read and where). Process / Keep document
//           only / Not a pet document.
//   Step 2  The values, one by one, each with its page and the exact words it came from: Accept, Correct or Not right.
//           "Accept all that passed checks" sits under the list, so it is only reached after the list has been seen.
//   File    writes the values (confirmed by an Owner / Primary carer; waiting for one when a Family member files), then
//           moves the original to the person's filed folder. The page text is shown beside the values, quotes marked.
import { ExternalLink } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ApiError, QuestionError, get, openDocument, post, postAsking, type Animal, type InboxItem, type Proposal } from './api';
import { niceDate, todayIso } from './format';
import { Card, ErrorText, Field, Section } from './ui';
import { DOC_KIND_WORDS, FIELD_WORDS, FLAG_WORDS, STATUS_WORDS, TARGET_WORDS } from './words';

const REVIEWABLE = ['NEEDS_REVIEW', 'ASSESS_FAILED', 'READ'];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The page text with every quote marked (whitespace-tolerant, as the engine's check). */
export function Marked({ text, quotes }: { text: string; quotes: string[] }) {
  const qs = quotes.map((q) => q.trim()).filter(Boolean);
  if (!qs.length) return <>{text}</>;
  const re = new RegExp(`(${qs.map((q) => q.split(/\s+/).map(esc).join('\\s+')).join('|')})`, 'g');
  const parts = text.split(re);
  return <>{parts.map((p, i) => (i % 2 === 1 ? <mark key={i} className="rounded bg-gold-soft px-0.5 text-ink">{p}</mark> : <span key={i}>{p}</span>))}</>;
}

export function InboxItemPage({ id, animals, onChanged }: { id: number; animals: Animal[]; onChanged?: () => void }) {
  const [it, setIt] = useState<InboxItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setIt(await get<InboxItem>(`api/inbox/${id}`)); } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not load this document.'); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  /** `asking`: an unusual weight comes back as a question (QuestionError) for the value's card to ask, not an error. */
  const act = async (path: string, body: unknown = {}, asking = false) => {
    setBusy(true); setError(null);
    try {
      setIt(await (asking ? postAsking<InboxItem> : post<InboxItem>)(`api/inbox/${id}/${path}`, body)); onChanged?.();
    } catch (e) {
      if (asking && e instanceof QuestionError) throw e;
      setError(e instanceof ApiError ? e.message : 'That did not work — try again.');
      if (path === 'file') void load(); // filing may have sent an unusual weight back to be checked
    } finally { setBusy(false); }
  };
  if (!it) return <main className="mx-auto max-w-5xl px-4 pt-6 pb-28">{error ? <ErrorText text={error} /> : <p className="text-ink-2" aria-busy="true">Loading…</p>}</main>;
  const reviewable = REVIEWABLE.includes(it.status);
  const decided = !!it.decided_by;
  const waiting = it.proposals.filter((p) => p.status === 'PROPOSED');
  const clean = waiting.filter((p) => p.flags.length === 0);
  return (
    <main className="mx-auto max-w-5xl px-4 pb-28 sm:px-6">
      <div className="mt-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="m-0 text-[14px] text-ink-2">{it.file_name}</p>
          <p className="m-0 text-[17px] font-semibold">{STATUS_WORDS[it.status] ?? it.status}</p>
          {it.filed_path && it.status === 'FILED' && <p className="m-0 text-[14px] text-ink-2">Filed to {it.filed_path}</p>}
        </div>
        <button type="button" className="btn min-h-10 px-4 text-[14px]" onClick={() => void openDocument(it.document_id).catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'The original could not be opened.'))}>
          <ExternalLink aria-hidden className="h-4 w-4" strokeWidth={1.75} />Open the original
        </button>
      </div>
      {it.flags.filter((f) => FLAG_WORDS[f]).map((f) => <p key={f} className="m-0 mt-2 text-[14px] text-amber">{FLAG_WORDS[f]}{f === 'VALUES_DROPPED' ? ` (${it.dropped_count})` : ''}</p>)}
      <ErrorText text={error} />
      <div className="grid gap-x-8 lg:grid-cols-2">
        <div>
          {reviewable && !decided && <StepOne it={it} animals={animals} busy={busy} onDecide={(b) => void act('decide', b)} onRetry={() => void act('retry')} />}
          {decided && (
            <Section title={reviewable ? 'Step 2 · The values' : 'What was read'}>
              {it.proposals.length === 0 && <p className="m-0 text-ink-2">No values to check{it.flags.includes('KEEP_ONLY') ? ' — kept as a document only' : ''}.</p>}
              <div className="grid gap-3">{it.proposals.map((p) => <ProposalCard key={p.id} p={p} open={reviewable} busy={busy} onDo={(b) => act(`proposals/${p.id}`, b, true)} />)}</div>
              {reviewable && clean.length > 0 && (
                <button type="button" className="btn mt-4" disabled={busy} onClick={() => void act('accept-all')}>Accept all {clean.length} that passed checks</button>
              )}
              {reviewable && (
                <div className="mt-6">
                  <p className="m-0 mb-3 text-[14px] text-ink-2">{it.can_confirm ? 'Filing saves the accepted values as records, confirmed by you, and moves the original to your filed folder.' : 'Filing saves the accepted values as waiting for an Owner or Primary carer to check, and moves the original to the filed folder.'}</p>
                  <button type="button" className="btn btn-primary" disabled={busy || waiting.length > 0} onClick={() => void act('file')}>{waiting.length ? `${waiting.length} still to look at` : 'File it'}</button>
                </div>
              )}
            </Section>
          )}
        </div>
        {it.pages.length > 0 && (
          <Section title={`The document${it.read_by === 'OCR' ? ' (read at home from the picture)' : ''}`}>
            {it.pages.map((pg) => (
              <Card key={pg.page} className="mb-3 p-4">
                <p className="m-0 mb-2 text-[13px] font-semibold text-ink-2">Page {pg.page}</p>
                <pre className="m-0 max-h-[60vh] overflow-auto whitespace-pre-wrap break-words font-sans text-[14px] leading-relaxed"><Marked text={pg.text} quotes={it.proposals.filter((p) => p.page === pg.page).map((p) => p.quote)} /></pre>
              </Card>
            ))}
          </Section>
        )}
      </div>
    </main>
  );
}

function StepOne({ it, animals, busy, onDecide, onRetry }: { it: InboxItem; animals: Animal[]; busy: boolean; onDecide: (b: unknown) => void; onRetry: () => void }) {
  const mine = animals.filter((a) => a.status === 'ACTIVE' && a.can.includes('DROP_DOCUMENTS'));
  const [animal, setAnimal] = useState<number | ''>(it.animal_proposed_id ?? (mine.length === 1 ? mine[0]!.id : ''));
  const [kind, setKind] = useState(it.doc_kind_proposed ?? 'OTHER');
  // 03/10/2026: 3 Oct or 10 Mar? The engine will not guess; the person sets the date (finding 4)
  const ambiguous = it.flags.includes('DATE_ORDER_AMBIGUOUS');
  const [date, setDate] = useState(it.document_date_assumed || ambiguous ? '' : it.document_date ?? '');
  const name = animals.find((a) => a.id === animal)?.name;
  const n = it.proposals.length;
  const needDate = it.document_date_assumed || !it.document_date || ambiguous;
  const unread = it.status === 'ASSESS_FAILED' || it.flags.includes('AWAITING_AI_GO_AHEAD') || it.status === 'READ';
  const found: ReactNode[] = [];
  if (it.found.animal) found.push(<li key="a">Animal: {it.found.animal.name ?? '—'}{it.found.animal.microchip ? ` (microchip ${it.found.animal.microchip})` : ''} <Q p={it.found.animal.page} q={it.found.animal.quote} /></li>);
  if (it.found.document_date) found.push(<li key="d">Date: {niceDate(it.found.document_date.value)} <Q p={it.found.document_date.page} q={it.found.document_date.quote} /></li>);
  if (it.found.provider) found.push(<li key="p">From: {it.found.provider.name} <Q p={it.found.provider.page} q={it.found.provider.quote} /></li>);
  return (
    <Section title="Step 1 · What is it?">
      <Card className="p-4">
        {unread ? (
          <p className="m-0">{it.status === 'ASSESS_FAILED' ? 'This couldn’t be read. ' : 'This hasn’t been read. '}You can keep it as a document and enter the details by hand on the animal’s Health tab.</p>
        ) : (
          <p className="m-0 text-[17px]">This looks like {DOC_KIND_WORDS[kind]?.toLowerCase().replace(/^(\w)/, (m) => (/^[aeiou]/i.test(m) ? `an ${m}` : `a ${m}`)) ?? 'a document'}{name ? <> for <strong>{name}</strong></> : ''}{it.document_date && !it.document_date_assumed ? ` from ${niceDate(it.document_date)}` : ''}, with {n} value{n === 1 ? '' : 's'}.</p>
        )}
        {found.length > 0 && <ul className="m-0 mt-3 list-none p-0 text-[14px] text-ink-2">{found}</ul>}
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Field label="Animal">
            <select className="field" value={animal} onChange={(e) => setAnimal(e.target.value ? Number(e.target.value) : '')}>
              <option value="">Choose…</option>
              {mine.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Kind">
            <select className="field" value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(DOC_KIND_WORDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </Field>
          <Field label={ambiguous ? 'Date (day/month unclear — please set)' : needDate ? 'Date (not printed — please set)' : 'Date'}><input className="field" type="date" max={todayIso()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {!unread && <button type="button" className="btn btn-primary" disabled={busy || !animal || (needDate && !date)} onClick={() => onDecide({ action: 'PROCESS', animal_id: animal, doc_kind: kind, ...(date ? { document_date: date } : {}) })}>Yes, check the values</button>}
          <button type="button" className="btn" disabled={busy || !animal || (needDate && !date)} onClick={() => onDecide({ action: 'KEEP_ONLY', animal_id: animal, doc_kind: kind, ...(date ? { document_date: date } : {}) })}>Keep document only</button>
          <button type="button" className="btn" disabled={busy} onClick={() => onDecide({ action: 'NOT_PET' })}>Not a pet document</button>
          {it.status === 'ASSESS_FAILED' && <button type="button" className="btn" disabled={busy} onClick={onRetry}>Try reading again</button>}
        </div>
      </Card>
    </Section>
  );
}

const Q = ({ p, q }: { p: number; q: string }) => <span className="block text-[13px]">page {p}: “{q}”</span>;

function ProposalCard({ p, open, busy, onDo }: { p: Proposal; open: boolean; busy: boolean; onDo: (b: Record<string, unknown>) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  // An unusual weight (finding 5): nothing is accepted until the person answers -- "yes, that's right" sends
  // confirm_unusual, recorded with their name; or they take the suggestion. Same question as typing a weight.
  const [asked, setAsked] = useState<{ q: QuestionError; body: Record<string, unknown> } | null>(null);
  const send = async (b: Record<string, unknown>) => {
    setAsked(null);
    try { await onDo(b); } catch (e) { if (e instanceof QuestionError) setAsked({ q: e, body: b }); }
  };
  const shown = p.corrected ?? p.payload;
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(p.payload).filter(([k]) => k !== 'cost_currency').map(([k, v]) => [k, v === null ? '' : String(v)])));
  const tone = p.status === 'DISMISSED' ? 'opacity-60' : '';
  return (
    <Card className={`p-4 ${tone}`}>
      <div className="flex items-start justify-between gap-3">
        <p className="m-0 font-semibold">{TARGET_WORDS[p.target] ?? p.target}</p>
        <span className="text-[13px] font-semibold text-ink-2">{p.status === 'PROPOSED' ? 'Read from document — check' : p.status === 'ACCEPTED' ? 'Accepted' : p.status === 'CORRECTED' ? 'Corrected' : 'Not right'}</span>
      </div>
      {!editing && (
        <dl className="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[15px]">
          {Object.entries(shown).filter(([k, v]) => v !== null && v !== '' && k !== 'cost_currency').map(([k, v]) => (
            <div key={k} className="contents"><dt className="text-ink-2">{FIELD_WORDS[k] ?? k}</dt><dd className="m-0">{/_on$/.test(k) ? niceDate(String(v)) : /^[A-Z][A-Z_]+$/.test(String(v)) ? String(v).charAt(0) + String(v).slice(1).toLowerCase().replace(/_/g, ' ') : String(v)}{k === 'cost_amount' && shown.cost_currency ? ` ${String(shown.cost_currency)}` : ''}</dd></div>
          ))}
        </dl>
      )}
      {editing && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {Object.keys(vals).map((k) => <Field key={k} label={FIELD_WORDS[k] ?? k}><input className="field" value={vals[k]} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} /></Field>)}
        </div>
      )}
      <p className="m-0 mt-2 text-[13px] text-ink-2">Page {p.page}: “{p.quote}”</p>
      {p.flags.map((f) => <p key={f} className="m-0 mt-1 text-[13px] text-amber">{FLAG_WORDS[f] ?? f}</p>)}
      {open && (
        <div className="mt-3 flex flex-wrap gap-2">
          {editing ? (
            <>
              <button type="button" className="btn btn-primary min-h-10 px-4 text-[14px]" disabled={busy} onClick={() => { void send({ action: 'correct', values: vals }); setEditing(false); }}>Save correction</button>
              <button type="button" className="btn min-h-10 px-4 text-[14px]" onClick={() => setEditing(false)}>Cancel</button>
            </>
          ) : asked ? (
            <div className="grid gap-2">
              <p className="m-0 text-[15px] font-semibold text-amber" role="alert">{asked.q.message}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn btn-primary min-h-10 px-4 text-[14px]" disabled={busy} onClick={() => void send({ ...asked.body, confirm_unusual: true })}>Yes, that’s right</button>
                {asked.q.suggestion && (
                  <button type="button" className="btn min-h-10 px-4 text-[14px]" disabled={busy} onClick={() => { const sg = asked.q.suggestion!; void send({ action: 'correct', values: { ...vals, ...((asked.body.values as Record<string, string> | undefined) ?? {}), value: sg.value, unit: sg.unit } }); }}>
                    Use {asked.q.suggestion.value} {asked.q.suggestion.unit}
                  </button>
                )}
                <button type="button" className="btn min-h-10 px-4 text-[14px]" onClick={() => setAsked(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <>
              <button type="button" className="btn min-h-10 px-4 text-[14px]" disabled={busy || p.status === 'ACCEPTED'} onClick={() => void send({ action: 'accept' })}>Accept</button>
              <button type="button" className="btn min-h-10 px-4 text-[14px]" disabled={busy} onClick={() => setEditing(true)}>Correct</button>
              <button type="button" className="btn min-h-10 px-4 text-[14px]" disabled={busy || p.status === 'DISMISSED'} onClick={() => void send({ action: 'dismiss' })}>Not right</button>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
