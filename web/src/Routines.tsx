// Care routines, today's care and the shared care log for one animal (spec sec 3.5, 8.3; S6, A22-A24).
// Owner / Primary carer set routines up (species suggestions are offered as tick-boxes, never auto-created) and stop
// them; anyone but a Viewer ticks Done. Every section with nothing to show is hidden.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AgendaList } from './Agenda';
import { Appointments } from './Appointments';
import { ApiError, get, post, type Animal, type CareView } from './api';
import { niceDate, todayIso } from './format';
import { AddButton, Card, ErrorText, Field, Panel, Section } from './ui';
import { ROUTINE_WORDS, scheduleWords } from './words';

const FREQS = [['FREQ=DAILY', 'Every day'], ['FREQ=WEEKLY', 'Every week'], ['FREQ=MONTHLY', 'Every month'], ['FREQ=YEARLY', 'Every year']] as const;

export function CareSection({ a, onChanged }: { a: Animal; onChanged: () => void }) {
  const [v, setV] = useState<CareView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(async () => {
    try { const r = await get<CareView>(`api/animals/${a.id}/care`); setV(Array.isArray(r?.routines) ? r : null); } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not load the care routines.'); }
  }, [a.id]);
  useEffect(() => { void load(); }, [load]);
  const manage = a.can.includes('MANAGE_CARE');
  const refresh = () => { void load(); onChanged(); };
  if (error) return <ErrorText text={error} />;
  if (!v) return null;
  const add = async (body: unknown) => { await post(`api/animals/${a.id}/routines`, body); refresh(); };
  return (
    <>
      {v.today.length > 0 && <Section title="Today"><AgendaList items={v.today} showAnimal={false} done onDone={refresh} /></Section>}
      {v.coming_up.length > 0 && <Section title="Coming up"><AgendaList items={v.coming_up} showAnimal={false} /></Section>}
      {(v.routines.length > 0 || manage) && (
        <Section title="Routines" action={manage && !open ? <AddButton label="Add routine" onClick={() => setOpen(true)} /> : undefined}>
          {open && <RoutineForm a={a} onClose={() => setOpen(false)} onSave={async (b) => { await add(b); setOpen(false); }} />}
          {v.routines.length > 0 && (
            <Card className="divide-y divide-line overflow-hidden">
              {v.routines.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="m-0 font-semibold">{r.title}{r.origin === 'VET_ADVICE' ? <span className="font-normal text-ink-2"> · vet advice</span> : null}</p>
                    <p className="m-0 text-[14px] text-ink-2">{scheduleWords(r.rrule, r.times)}{r.next_due ? ` · next ${niceDate(r.next_due)}` : ''}</p>
                  </div>
                  {manage && <button type="button" className="btn min-h-10 shrink-0 px-3 text-[14px]" onClick={() => void post(`api/animals/${a.id}/routines/${r.id}/retire`).then(refresh)}>Stop</button>}
                </div>
              ))}
            </Card>
          )}
          {manage && v.suggestions.length > 0 && (
            <div className="mt-4">
              <p className="m-0 mb-2 text-[14px] text-ink-2">Suggested for {a.name} — a starting schedule, change it any time:</p>
              <div className="flex flex-wrap gap-2">
                {v.suggestions.map((s) => (
                  <button key={s.kind} type="button" className="btn min-h-10 px-3 text-[14px]" onClick={() => void add({ kind: s.kind, rrule: s.rrule, times: s.times, origin: 'SPECIES_DEFAULT' })}>
                    + {s.title} <span className="font-normal text-ink-2">({scheduleWords(s.rrule, s.times).toLowerCase()})</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {v.routines.length === 0 && !open && manage && v.suggestions.length === 0 && <p className="m-0 text-[15px] text-ink-2">No routines yet.</p>}
        </Section>
      )}
      {v.supplies.length > 0 && (
        <Section title="Medicine supply">
          <Card className="divide-y divide-line overflow-hidden">
            {v.supplies.map((s) => (
              <p key={s.medication_id} className="m-0 px-4 py-3">{s.product_name}: <span className={s.days_left !== null && s.days_left < 7 ? 'text-amber' : 'text-ink-2'}>{s.days_left === null ? 'no schedule' : `about ${Math.floor(s.days_left)} days left`}</span></p>
            ))}
          </Card>
        </Section>
      )}
      <Appointments a={a} list={v.appointments} onChanged={refresh} />
      {v.log.length > 0 && (
        <Section title="Care log">
          <Card className="divide-y divide-line overflow-hidden">
            {v.log.slice(0, 10).map((l) => (
              <p key={l.id} className="m-0 px-4 py-2.5 text-[15px]">{ROUTINE_WORDS[l.kind] ?? l.kind}{l.due_slot ? ` ${l.due_slot}` : ''} <span className="text-ink-2">· {l.done_by} · {new Date(l.done_at).toLocaleString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>{l.note ? <span className="text-ink-2"> · {l.note}</span> : null}</p>
            ))}
          </Card>
        </Section>
      )}
    </>
  );
}

function RoutineForm({ a, onClose, onSave }: { a: Animal; onClose: () => void; onSave: (b: unknown) => Promise<void> }) {
  const meds = a.current_medication;
  const [kind, setKind] = useState('WALK');
  const [freq, setFreq] = useState<string>('FREQ=DAILY');
  const [every, setEvery] = useState('1');
  const [times, setTimes] = useState('');
  const [from, setFrom] = useState(todayIso());
  const [med, setMed] = useState<number | ''>(meds[0]?.medication_id ?? '');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const t = times.split(/[,\s]+/).map((x) => x.trim().replace('.', ':')).filter(Boolean).map((x) => (/^\d:/.test(x) ? `0${x}` : x));
      await onSave({ kind, title: title || null, rrule: Number(every) > 1 ? `${freq};INTERVAL=${Number(every)}` : freq, times: t, active_from: from, ...(kind === 'MEDICATION' ? { medication_id: med } : {}) });
    } catch (er) { setError(er instanceof ApiError ? er.message : 'The routine could not be saved.'); } finally { setBusy(false); }
  }
  return (
    <Panel title={`A routine for ${a.name}`} onClose={onClose}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label="What">
          <select className="field" value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(ROUTINE_WORDS).filter(([k]) => k !== 'MEDICATION' || meds.length > 0).map(([k, w]) => <option key={k} value={k}>{w}</option>)}
          </select>
        </Field>
        {kind === 'MEDICATION' ? (
          <Field label="Medicine"><select className="field" value={med} onChange={(e) => setMed(Number(e.target.value))}>{meds.map((m) => <option key={m.medication_id} value={m.medication_id}>{m.product_name}</option>)}</select></Field>
        ) : (
          <Field label="Name (optional)"><input className="field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={ROUTINE_WORDS[kind]} /></Field>
        )}
        <div className="grid grid-cols-[1fr_5rem] gap-2">
          <Field label="How often"><select className="field" value={freq} onChange={(e) => setFreq(e.target.value)}>{FREQS.map(([k, w]) => <option key={k} value={k}>{w}</option>)}</select></Field>
          <Field label="Every"><input className="field" inputMode="numeric" value={every} onChange={(e) => setEvery(e.target.value.replace(/\D/g, ''))} /></Field>
        </div>
        <Field label="Times (optional)" hint="e.g. 08:00, 18:00"><input className="field" value={times} onChange={(e) => setTimes(e.target.value)} placeholder="08:00" /></Field>
        <Field label="Starting"><input className="field" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <div className="sm:col-span-2">
          <button className="btn btn-primary" disabled={busy || (kind === 'MEDICATION' && !med)}>{busy ? 'Saving…' : 'Save routine'}</button>
          <ErrorText text={error} />
        </div>
      </form>
    </Panel>
  );
}
