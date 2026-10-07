// Medication on the Health tab (S4, A18). "Current" is derived by the engine from the dated events: stopping a
// medicine takes it off the list; its history stays below. Owner / Primary carer add, change the dose, stop or restart.
import { useState, type FormEvent } from 'react';
import { ApiError, post, type Animal, type Medications as Meds, type Medicine } from './api';
import { niceDate, todayIso } from './format';
import { SOURCES } from './recordDefs';
import { AddButton, BadgeChip, Card, ErrorText, Field, Panel, Section } from './ui';

const EVENT_WORDS = { PRESCRIBED: 'Prescribed', STARTED: 'Started', DOSE_CHANGED: 'Dose changed', STOPPED: 'Stopped' } as const;
type Act = { kind: 'new' } | { kind: 'DOSE_CHANGED' | 'STOPPED' | 'STARTED'; med: Medicine };

export function MedicationSection({ a, meds, onSaved }: { a: Animal; meds: Meds; onSaved: () => void }) {
  const canManage = a.can.includes('MANAGE_CARE');
  const [act, setAct] = useState<Act | null>(null);
  const past = meds.medicines.filter((m) => !m.current);
  if (!meds.medicines.length && !canManage) return null;
  const done = () => { setAct(null); onSaved(); };
  return (
    <Section title="Medication" action={canManage && !act ? <AddButton label="Add medicine" onClick={() => setAct({ kind: 'new' })} /> : undefined}>
      {act && <MedForm a={a} act={act} onClose={() => setAct(null)} onSaved={done} />}
      {meds.current.length > 0 ? (
        <Card className="divide-y divide-line overflow-hidden">
          {meds.current.map((m) => {
            const med = meds.medicines.find((x) => x.id === m.medication_id)!;
            return (
              <div key={m.medication_id} className="px-4 py-3">
                <p className="m-0 font-semibold">{m.product_name}{m.strength && <span className="font-normal text-ink-2"> · {m.strength}</span>}</p>
                {(m.dose || m.frequency) && <p className="m-0 text-[15px]">{[m.dose, m.frequency].filter(Boolean).join(', ')}</p>}
                {m.instructions && <p className="m-0 text-[14px] text-ink-2">“{m.instructions}”</p>}
                <p className="m-0 text-[13px] text-ink-2">Since {niceDate(m.since)}</p>
                {canManage && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" className="btn min-h-10 px-3 text-[14px]" onClick={() => setAct({ kind: 'DOSE_CHANGED', med })}>Change dose</button>
                    <button type="button" className="btn min-h-10 px-3 text-[14px]" onClick={() => setAct({ kind: 'STOPPED', med })}>Stop</button>
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      ) : !act && <p className="m-0 text-[15px] text-ink-2">No current medication.</p>}
      {past.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[15px] text-ink-2">Past medicines ({past.length})</summary>
          <Card className="mt-2 divide-y divide-line overflow-hidden">
            {past.map((m) => (
              <div key={m.id} className="px-4 py-3">
                <p className="m-0 font-medium">{m.product_name}</p>
                <ul className="m-0 mt-1 list-none p-0 text-[13px] text-ink-2">
                  {m.events.map((e) => <li key={e.id} className="flex flex-wrap items-center gap-2">{EVENT_WORDS[e.event_kind]} {niceDate(e.event_on)}{e.reason ? ` · ${e.reason}` : ''} <BadgeChip badge={e.badge} /></li>)}
                </ul>
                {canManage && <button type="button" className="btn mt-2 min-h-10 px-3 text-[14px]" onClick={() => setAct({ kind: 'STARTED', med: m })}>Start again</button>}
              </div>
            ))}
          </Card>
        </details>
      )}
    </Section>
  );
}

function MedForm({ a, act, onClose, onSaved }: { a: Animal; act: Act; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [strength, setStrength] = useState('');
  const [on, setOn] = useState(todayIso());
  const [dose, setDose] = useState('');
  const [frequency, setFrequency] = useState('');
  const [instructions, setInstructions] = useState('');
  const [reason, setReason] = useState('');
  const [source, setSource] = useState('VET_ADVICE');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stopping = act.kind === 'STOPPED';
  const title = act.kind === 'new' ? 'Add a medicine' : `${EVENT_WORDS[act.kind]}: ${act.med.product_name}`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const t = (v: string) => v.trim() || undefined;
    const ev = { event_on: on, source, dose_text: stopping ? undefined : t(dose), frequency: stopping ? undefined : t(frequency), instructions_verbatim: stopping ? undefined : t(instructions), reason: t(reason) };
    try {
      if (act.kind === 'new') await post(`api/animals/${a.id}/medications`, { product_name: name, strength: t(strength), start: { event_kind: 'STARTED', ...ev } });
      else await post(`api/animals/${a.id}/medications/${act.med.id}/events`, { event_kind: act.kind, ...ev });
      onSaved();
    } catch (er) {
      setError(er instanceof ApiError ? er.message : 'This could not be saved.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title={title} onClose={onClose}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        {act.kind === 'new' && (
          <>
            <Field label="Medicine"><input className="field" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Strength (optional)"><input className="field" value={strength} onChange={(e) => setStrength(e.target.value)} placeholder="50 mg" /></Field>
          </>
        )}
        <Field label={stopping ? 'Stopped on' : act.kind === 'DOSE_CHANGED' ? 'New dose from' : 'Started on'}><input className="field" type="date" max={todayIso()} value={on} onChange={(e) => setOn(e.target.value)} /></Field>
        {!stopping && <Field label={act.kind === 'DOSE_CHANGED' ? 'New dose' : 'Dose (optional)'}><input className="field" value={dose} onChange={(e) => setDose(e.target.value)} placeholder="half a tablet" /></Field>}
        {!stopping && <Field label="How often (optional)"><input className="field" value={frequency} onChange={(e) => setFrequency(e.target.value)} placeholder="twice a day" /></Field>}
        {!stopping && <div className="sm:col-span-2"><Field label="Instructions, word for word (optional)"><textarea className="field min-h-[72px]" value={instructions} onChange={(e) => setInstructions(e.target.value)} /></Field></div>}
        <Field label="Reason (optional)"><input className="field" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={stopping ? 'course finished' : ''} /></Field>
        <div className="sm:col-span-2">
          <span className="mb-1.5 block text-[14px] font-medium">Where is this from?</span>
          <div className="seg" role="group" aria-label="Where is this from?">{SOURCES.map(([k, w]) => <button key={k} type="button" aria-pressed={source === k} onClick={() => setSource(k)}>{w}</button>)}</div>
        </div>
        <div className="sm:col-span-2">
          <button className="btn btn-primary" disabled={busy || (act.kind === 'new' && !name.trim()) || (act.kind === 'DOSE_CHANGED' && !dose.trim())}>{busy ? 'Saving…' : stopping ? 'Stop medicine' : 'Save'}</button>
          <ErrorText text={error} />
        </div>
      </form>
    </Panel>
  );
}
