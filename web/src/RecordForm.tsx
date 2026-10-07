// One form for every vet record kind (S4, A17), built from recordDefs.ts. "Where is this from?" sets the source badge
// (Our note / Vet record / Vet advice). A Family member's entry is sent the same way; the engine makes it a proposal.
import { useState, type FormEvent } from 'react';
import { ApiError, post, type Contact, type RecordRow } from './api';
import { niceDate, todayIso } from './format';
import { SOURCES, type KindDef } from './recordDefs';
import { ErrorText, Field, Panel } from './ui';

export function RecordForm({ animalId, kind, contacts, visits, existing, confirms, onClose, onSaved }: {
  animalId: number; kind: KindDef; contacts: Contact[]; visits: RecordRow[]; existing?: RecordRow; confirms: boolean;
  onClose: () => void; onSaved: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const f of kind.fields) {
      const x = existing?.fields[f.name];
      v[f.name] = x === null || x === undefined ? (f.name === kind.date && f.required ? todayIso() : f.options?.[0]?.[0] ?? '') : String(x);
    }
    return v;
  });
  const [source, setSource] = useState(existing ? (existing.badge.code === 'VET_RECORD' ? 'VET_RECORD' : existing.badge.code === 'VET_ADVICE' ? 'VET_ADVICE' : 'OWNER_OBSERVATION') : 'OWNER_OBSERVATION');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: string) => setValues((o) => ({ ...o, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = { source };
    for (const f of kind.fields) {
      const v = values[f.name]?.trim() ?? '';
      if (!v) continue;
      body[f.name] = f.type === 'contact' || f.type === 'visit' ? Number(v) : v;
    }
    try {
      await post(`api/animals/${animalId}/records/${kind.code}${existing ? `/${existing.id}/correct` : ''}`, body);
      onSaved();
    } catch (er) {
      setError(er instanceof ApiError ? er.message : 'This could not be saved.');
    } finally {
      setBusy(false);
    }
  }
  const required = kind.fields.filter((f) => f.required).every((f) => values[f.name]?.trim());

  return (
    <Panel title={existing ? `Correct ${kind.one.toLowerCase()}` : `Add ${kind.one.toLowerCase()}`} onClose={onClose}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <span className="mb-1.5 block text-[14px] font-medium">Where is this from?</span>
          <div className="seg" role="group" aria-label="Where is this from?">
            {SOURCES.map(([k, w]) => <button key={k} type="button" aria-pressed={source === k} onClick={() => setSource(k)}>{w}</button>)}
          </div>
        </div>
        {kind.fields.map((f) => {
          const v = values[f.name] ?? '';
          const wide = f.type === 'long' ? 'sm:col-span-2' : '';
          const label = f.required ? f.label : `${f.label} (optional)`;
          let input;
          if (f.type === 'long') input = <textarea className="field min-h-[88px]" value={v} onChange={(e) => set(f.name, e.target.value)} />;
          else if (f.type === 'enum') input = <select className="field" value={v} onChange={(e) => set(f.name, e.target.value)}>{f.options!.map(([k, w]) => <option key={k} value={k}>{w}</option>)}</select>;
          else if (f.type === 'date') input = <input className="field" type="date" value={v} onChange={(e) => set(f.name, e.target.value)} />;
          else if (f.type === 'money') input = <input className="field" inputMode="decimal" value={v} onChange={(e) => set(f.name, e.target.value)} placeholder="65.00" />;
          else if (f.type === 'contact') {
            if (!contacts.length) return null;
            input = <select className="field" value={v} onChange={(e) => set(f.name, e.target.value)}><option value="">—</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>;
          } else if (f.type === 'visit') {
            if (!visits.length) return null;
            input = <select className="field" value={v} onChange={(e) => set(f.name, e.target.value)}><option value="">—</option>{visits.map((x) => <option key={x.id} value={x.id}>{niceDate(String(x.fields.visit_on))}{x.fields.reason ? ` · ${String(x.fields.reason)}` : ''}</option>)}</select>;
          } else input = <input className="field" value={v} inputMode={f.type === 'vdate' ? 'numeric' : undefined} onChange={(e) => set(f.name, e.target.value)} />;
          return <div key={f.name} className={wide}><Field label={label} hint={f.hint}>{input}</Field></div>;
        })}
        <div className="sm:col-span-2">
          {!confirms && <p className="m-0 mb-3 text-[14px] text-ink-2">This will wait for an Owner or Primary carer to check it.</p>}
          {existing && <p className="m-0 mb-3 text-[14px] text-ink-2">The earlier entry is kept in the record; this one replaces it on screen{confirms ? '' : ' once it is checked'}.</p>}
          <button className="btn btn-primary" disabled={busy || !required}>{busy ? 'Saving…' : 'Save'}</button>
          <ErrorText text={error} />
        </div>
      </form>
    </Panel>
  );
}
