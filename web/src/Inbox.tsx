// The Inbox (spec sec 5, 8.2, 9.4; S5, A20): your Pets folder and your two go-aheads, the Add button, and what is
// waiting to be checked. Nothing is read until you say yes; no document text goes to Claude until you say yes to that
// too -- both are yours alone, and either can be turned off here at any time.
import { FilePlus2, FolderOpen } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, get, post, type Animal, type InboxList, type InboxRow, type MyInbox } from './api';
import { niceDate } from './format';
import { Card, ErrorText, Field, Section } from './ui';
import { DOC_KIND_WORDS, FLAG_WORDS, STATUS_WORDS } from './words';

const readAsBase64 = (f: File): Promise<string> => new Promise((ok, fail) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ''));
  r.onerror = () => fail(new Error('could not read the file'));
  r.readAsDataURL(f);
});

export function InboxScreen({ animals, onChanged }: { animals: Animal[]; onChanged?: () => void }) {
  const [me, setMe] = useState<MyInbox | null>(null);
  const [list, setList] = useState<InboxList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [m, l] = await Promise.all([get<MyInbox>('api/inbox/me'), get<InboxList>('api/inbox')]);
      setMe(m); setList(l);
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not load the inbox.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const canDrop = animals.length === 0 || animals.some((a) => a.can.includes('DROP_DOCUMENTS'));
  if (error) return <main className="mx-auto max-w-3xl px-4 pb-28 pt-6"><ErrorText text={error} /></main>;
  if (!me || !list) return <main className="mx-auto max-w-3xl px-4 pt-6"><p className="text-ink-2" aria-busy="true">Loading…</p></main>;
  const name = (id: number | null) => animals.find((a) => a.id === id)?.name ?? null;
  return (
    <main className="mx-auto max-w-3xl px-4 pb-28 sm:px-6">
      {canDrop && <Setup me={me} onChange={(m) => { setMe(m); void load(); }} onAdded={() => { void load(); onChanged?.(); setTimeout(() => void load(), 4000); }} />}
      {list.waiting.length > 0 && (
        <Section title="To check">
          <Card className="divide-y divide-line overflow-hidden">{list.waiting.map((x) => <ItemRow key={x.id} x={x} animal={name(x.animal_id ?? x.animal_proposed_id)} />)}</Card>
        </Section>
      )}
      {list.waiting.length === 0 && <p className="mt-8 text-ink-2">Nothing waiting to be checked.</p>}
      {list.recent.length > 0 && (
        <Section title="Recently filed">
          <Card className="divide-y divide-line overflow-hidden">{list.recent.map((x) => <ItemRow key={x.id} x={x} animal={name(x.animal_id)} />)}</Card>
        </Section>
      )}
    </main>
  );
}

function ItemRow({ x, animal }: { x: InboxRow; animal: string | null }) {
  const kind = x.doc_kind ?? x.doc_kind_proposed;
  return (
    <a href={`#/inbox/${x.id}`} className="block px-4 py-3 text-ink no-underline">
      <p className="m-0 font-semibold">{kind ? DOC_KIND_WORDS[kind] ?? kind : x.file_name}{animal ? ` · ${animal}` : ''}</p>
      <p className="m-0 text-[14px] text-ink-2">{STATUS_WORDS[x.status] ?? x.status}{x.document_date ? ` · ${niceDate(x.document_date)}` : ''}{x.proposals ? ` · ${x.proposals} value${x.proposals === 1 ? '' : 's'}` : ''}</p>
      {x.flags.filter((f) => FLAG_WORDS[f]).slice(0, 2).map((f) => <p key={f} className="m-0 text-[13px] text-amber">{FLAG_WORDS[f]}</p>)}
    </a>
  );
}

function Setup({ me, onChange, onAdded }: { me: MyInbox; onChange: (m: MyInbox) => void; onAdded: () => void }) {
  const [folder, setFolder] = useState(me.suggested_folder);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const act = async (fn: () => Promise<MyInbox>) => {
    setBusy(true); setError(null);
    try { onChange(await fn()); } catch (e) { setError(e instanceof ApiError ? e.message : 'That did not work — try again.'); } finally { setBusy(false); }
  };
  const consent = (kind: 'FOLDER_READ' | 'AI_READING', given: boolean) => act(() => post<MyInbox>(`api/inbox/me/consent${given ? '' : '/withdraw'}`, { kind }));
  async function upload(f: File | undefined) {
    if (!f) return;
    setBusy(true); setError(null); setAdded(null);
    try {
      await post('api/inbox/documents', { file_name: f.name || 'photo.jpg', data_base64: await readAsBase64(f) });
      setAdded(me.reading ? `${f.name || 'Your photo'} is in your inbox and will be read in a minute.` : `${f.name || 'Your photo'} is in your inbox. It will be read once you say yes below.`);
      onAdded();
    } catch (e) { setError(e instanceof ApiError ? e.message : 'The file could not be added.'); } finally { setBusy(false); if (file.current) file.current.value = ''; }
  }
  if (!me.folder) {
    const submit = (e: FormEvent) => { e.preventDefault(); void act(() => post<MyInbox>('api/inbox/me/folder', { folder })); };
    return (
      <Section title="Your Pets folder">
        <Card className="p-4">
          <p className="m-0">Drop vet letters, invoices and certificates into your own folder in the household vault, or add them here. Petopia keeps the original and files it once someone has checked it.</p>
          <form onSubmit={submit} className="mt-4 flex flex-wrap items-end gap-3">
            <div className="min-w-48 flex-1"><Field label="Folder in the vault" hint={`Files go in ${folder || '…'}/Pets/inbox`}><input className="field" value={folder} onChange={(e) => setFolder(e.target.value)} /></Field></div>
            <button className="btn btn-primary" disabled={busy || !folder.trim()}><FolderOpen aria-hidden className="h-5 w-5" strokeWidth={1.75} />Set up my folder</button>
          </form>
          <ErrorText text={error} />
        </Card>
      </Section>
    );
  }
  return (
    <Section title="Your Pets folder" action={
      <label className="btn btn-primary min-h-10 cursor-pointer px-4 text-[14px]">
        <FilePlus2 aria-hidden className="h-4 w-4" strokeWidth={2} />Add document
        <input ref={file} type="file" className="sr-only" accept=".pdf,.docx,.txt,.md,image/jpeg,image/png" disabled={busy} onChange={(e) => void upload(e.target.files?.[0])} />
      </label>
    }>
      <Card className="divide-y divide-line">
        <div className="p-4">
          <p className="m-0 text-[14px] text-ink-2">{me.inbox_path}</p>
          {me.reading ? (
            <Toggle label="Reading my folder" on detail="Petopia reads new files here every minute." busy={busy} onOff={() => void consent('FOLDER_READ', false)} />
          ) : (
            <Ask words={me.folder_words} yes="Yes, read my Pets folder" busy={busy} onYes={() => void consent('FOLDER_READ', true)} />
          )}
        </div>
        <div className="p-4">
          {me.ai_reading ? (
            <Toggle label="AI reading (Claude)" on detail="Document text is sent to Claude to be read; you check everything it finds." busy={busy} onOff={() => void consent('AI_READING', false)} />
          ) : (
            <>
              <Ask words={me.ai_words} yes="Yes, let Claude read the text" busy={busy || !me.reading} onYes={() => void consent('AI_READING', true)} />
              <p className="m-0 mt-2 text-[14px] text-ink-2">{me.local_reader ? 'Until then, documents are read by the computer at home (less reliably).' : 'Until then, documents wait for you to enter the details by hand.'}</p>
            </>
          )}
        </div>
      </Card>
      {added && <p role="status" className="m-0 mt-3 text-[15px] text-moss">{added}</p>}
      <ErrorText text={error} />
    </Section>
  );
}

function Ask({ words, yes, busy, onYes }: { words: string; yes: string; busy: boolean; onYes: () => void }) {
  return (
    <div className="mt-2">
      <p className="m-0 text-[15px]">{words}</p>
      <button type="button" className="btn mt-3" disabled={busy} onClick={onYes}>{yes}</button>
    </div>
  );
}
function Toggle({ label, on, detail, busy, onOff }: { label: string; on: boolean; detail: string; busy: boolean; onOff: () => void }) {
  return (
    <div className="mt-2 flex items-center justify-between gap-3">
      <div><p className="m-0 font-semibold">{label}: <span className="text-moss">{on ? 'on' : 'off'}</span></p><p className="m-0 text-[14px] text-ink-2">{detail}</p></div>
      <button type="button" className="btn min-h-10 shrink-0 px-4 text-[14px]" disabled={busy} onClick={onOff}>Turn off</button>
    </div>
  );
}
