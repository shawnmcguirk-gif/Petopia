// Weight on the Health tab (spec sec 9.4 "Weight"; S3, A16): chart, readings with the change since the last one, and
// the entry form. Units kg / g / lb (stored in kg by the engine). If a number looks like a slip the engine answers
// with a question; it is shown here with two explicit answers -- nothing is saved until the person picks one.
import { useState, type FormEvent } from 'react';
import { ApiError, QuestionError, postAsking, type Animal, type Measurement } from './api';
import { changeText, niceDate, todayIso } from './format';
import { AddButton, Card, ErrorText, Field, Panel, Section } from './ui';
import { WeightChart } from './WeightChart';

const UNITS = ['kg', 'g', 'lb'] as const;

export function WeightSection({ a, readings, onSaved }: { a: Animal; readings: Measurement[]; onSaved: () => void }) {
  const weights = readings.filter((r) => r.measure === 'weight');
  const others = readings.filter((r) => r.measure !== 'weight');
  const canAdd = a.can.includes('ADD_MEDIA');
  const [open, setOpen] = useState(false);
  if (!weights.length && !others.length && !canAdd) return null;
  return (
    <Section title="Weight" action={canAdd && !open ? <AddButton label="Add weight" onClick={() => setOpen(true)} /> : undefined}>
      {open && <WeightForm a={a} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); onSaved(); }} />}
      {weights.length > 0 && (
        <>
          <Card className="p-4"><WeightChart points={weights.map((w) => ({ on: w.on, value: Number(w.value) }))} today={todayIso()} /></Card>
          <Card className="mt-3 divide-y divide-line overflow-hidden">
            {[...weights].reverse().map((w) => (
              <div key={w.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="m-0 font-medium tabular-nums">{Number(w.value)} kg{w.unit_as_entered !== 'kg' && <span className="text-ink-2"> ({w.value_as_entered} {w.unit_as_entered})</span>}</p>
                  <p className="m-0 text-[13px] text-ink-2">{niceDate(w.on)} · Our note · {w.by}{w.unusual_confirmed ? ' · checked as unusual' : ''}</p>
                </div>
                {changeText(w.change, 'kg') && <span className="shrink-0 text-[14px] tabular-nums text-ink-2">{changeText(w.change, 'kg')}</span>}
              </div>
            ))}
          </Card>
        </>
      )}
      {!weights.length && !open && <p className="m-0 text-[15px] text-ink-2">No weight recorded yet.</p>}
      {others.length > 0 && (
        <Card className="mt-3 divide-y divide-line overflow-hidden">
          {[...others].reverse().map((m) => (
            <div key={m.id} className="flex justify-between gap-3 px-4 py-3 text-[15px]">
              <span>{m.measure === 'bcs' ? 'Body condition score' : m.measure === 'length' ? 'Length' : 'Height'}: <strong>{Number(m.value)} {m.unit}</strong></span>
              <span className="text-ink-2">{niceDate(m.on)}</span>
            </div>
          ))}
        </Card>
      )}
    </Section>
  );
}

export function WeightForm({ a, onClose, onSaved }: { a: Animal; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState('');
  const [unit, setUnit] = useState<string>('kg');
  const [on, setOn] = useState(todayIso());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState<QuestionError | null>(null);

  async function save(v: string, u: string, confirmUnusual: boolean) {
    setBusy(true);
    setError(null);
    try {
      await postAsking(`api/animals/${a.id}/measurements`, { measure: 'weight', value: v, unit: u, on, ...(confirmUnusual ? { confirm_unusual: true } : {}) });
      onSaved();
    } catch (e) {
      if (e instanceof QuestionError) setQuestion(e);
      else setError(e instanceof ApiError ? e.message : 'The weight could not be saved.');
    } finally {
      setBusy(false);
    }
  }
  const submit = (e: FormEvent) => { e.preventDefault(); if (value.trim()) void save(value.trim(), unit, false); };

  return (
    <Panel title={`Weigh ${a.name}`} onClose={onClose}>
      {question ? (
        <div role="alertdialog" aria-labelledby="wq" className="rounded-xl border border-amber/40 bg-gold-soft p-4">
          <p id="wq" className="m-0 text-[16px]">{question.message}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {question.suggestion && (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { const s = question.suggestion!; setQuestion(null); setValue(s.value); setUnit(s.unit); void save(s.value, s.unit, false); }}>
                Use {question.suggestion.value} {question.suggestion.unit}
              </button>
            )}
            <button type="button" className="btn" disabled={busy} onClick={() => { setQuestion(null); void save(value.trim(), unit, true); }}>Yes, {value.trim()} {unit} is right</button>
            <button type="button" className="btn border-0" disabled={busy} onClick={() => setQuestion(null)}>Change it</button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid grid-cols-[1fr_auto] items-end gap-3">
            <Field label="Weight"><input className="field tabular-nums" inputMode="decimal" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="6.1" /></Field>
            <div className="seg" role="group" aria-label="Unit">
              {UNITS.map((u) => <button key={u} type="button" aria-pressed={unit === u} onClick={() => setUnit(u)}>{u}</button>)}
            </div>
          </div>
          <Field label="Weighed on"><input className="field" type="date" max={todayIso()} value={on} onChange={(e) => setOn(e.target.value)} /></Field>
          <div><button className="btn btn-primary" disabled={busy || !value.trim()}>{busy ? 'Saving…' : 'Save weight'}</button></div>
          <ErrorText text={error} />
        </form>
      )}
    </Panel>
  );
}
