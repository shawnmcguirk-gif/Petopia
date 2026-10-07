// Care & food (spec sec 8.3; S3, A15): the current food and its history. Changing the food never overwrites -- the
// engine ends the old plan on the day the new one starts and both stay visible here. Owner / Primary carer change it;
// everyone else sees it. Routines and the care log arrive with S6.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, get, post, type Animal, type FeedingState } from './api';
import { niceDate, todayIso } from './format';
import { AddButton, BadgeChip, Card, ErrorText, Field, Panel, Section } from './ui';
import { FOOD_TYPE_WORDS, foodLine } from './words';

const PORTION_UNITS = ['g', 'kg', 'ml', 'cup', 'can', 'pouch', 'scoop', 'tbsp', 'piece'];

export function CareTab({ a, onChanged }: { a: Animal; onChanged: () => void }) {
  const [state, setState] = useState<FeedingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(async () => {
    try { setState(await get<FeedingState>(`api/animals/${a.id}/feeding`)); } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not load the food.'); }
  }, [a.id]);
  useEffect(() => { void load(); }, [load]);
  const canChange = a.can.includes('MANAGE_CARE');

  if (error) return <ErrorText text={error} />;
  if (!state) return <p className="text-ink-2" aria-busy="true">Loading…</p>;
  const cur = state.current;
  return (
    <div>
      <Section title="Food" action={canChange && !open ? <AddButton label={cur ? 'Change food' : 'Add food'} onClick={() => setOpen(true)} /> : undefined}>
        {open && <FoodForm a={a} current={!!cur} onClose={() => setOpen(false)} onSaved={(s) => { setState(s); setOpen(false); onChanged(); }} />}
        {cur ? (
          <Card className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="m-0 text-[18px] font-semibold">{[cur.brand, cur.product].filter(Boolean).join(' ')}</p>
                <p className="m-0 mt-1 text-ink-2">{foodLine({ ...cur, brand: null, product: null })}</p>
                {cur.objective && <p className="m-0 mt-2 text-[15px]">Aim: {cur.objective}</p>}
                {cur.notes && <p className="m-0 mt-1 text-[15px] text-ink-2">{cur.notes}</p>}
                <p className="m-0 mt-2 text-[13px] text-ink-2">Since {niceDate(cur.from_on)} · {cur.by}</p>
              </div>
              <BadgeChip badge={cur.badge} />
            </div>
          </Card>
        ) : !open && <p className="m-0 text-[15px] text-ink-2">No food recorded yet.</p>}
      </Section>
      {state.history.length > 0 && (
        <Section title="Food history">
          <Card className="divide-y divide-line overflow-hidden">
            {state.history.map((f) => (
              <div key={f.id} className="px-4 py-3">
                <p className="m-0 font-medium">{[f.brand, f.product].filter(Boolean).join(' ')} <span className="font-normal text-ink-2">· {FOOD_TYPE_WORDS[f.food_type] ?? f.food_type}</span></p>
                <p className="m-0 text-[13px] text-ink-2">{niceDate(f.from_on)} – {niceDate(f.to_on)}</p>
              </div>
            ))}
          </Card>
        </Section>
      )}
    </div>
  );
}

function FoodForm({ a, current, onClose, onSaved }: { a: Animal; current: boolean; onClose: () => void; onSaved: (s: FeedingState) => void }) {
  const [brand, setBrand] = useState('');
  const [product, setProduct] = useState('');
  const [type, setType] = useState('DRY');
  const [amount, setAmount] = useState('');
  const [unit, setUnit] = useState('g');
  const [times, setTimes] = useState('');
  const [from, setFrom] = useState(todayIso());
  const [objective, setObjective] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const t = times.split(/[,\s]+/).map((x) => x.trim().replace('.', ':')).filter(Boolean);
      onSaved(await post<FeedingState>(`api/animals/${a.id}/feeding`, {
        brand, product, food_type: type, from_on: from, objective, times: t,
        ...(amount.trim() ? { portion_amount: amount.trim(), portion_unit: unit } : {}),
      }));
    } catch (er) {
      setError(er instanceof ApiError ? er.message : 'The food could not be saved.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title={current ? 'Change food' : `What ${a.name} eats`} onClose={onClose}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Brand"><input className="field" value={brand} onChange={(e) => setBrand(e.target.value)} /></Field>
        <Field label="Product"><input className="field" value={product} onChange={(e) => setProduct(e.target.value)} /></Field>
        <Field label="Type">
          <select className="field" value={type} onChange={(e) => setType(e.target.value)}>
            {Object.entries(FOOD_TYPE_WORDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Field label="Portion"><input className="field" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="60" /></Field>
          <Field label="Unit"><select className="field" value={unit} onChange={(e) => setUnit(e.target.value)}>{PORTION_UNITS.map((u) => <option key={u}>{u}</option>)}</select></Field>
        </div>
        <Field label="Times" hint="e.g. 08:00, 18:00"><input className="field" value={times} onChange={(e) => setTimes(e.target.value)} placeholder="08:00, 18:00" /></Field>
        <Field label={current ? 'New food from' : 'Since'}><input className="field" type="date" max={todayIso()} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <div className="sm:col-span-2"><Field label="Aim (optional)"><input className="field" value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="keep weight steady" /></Field></div>
        <div className="sm:col-span-2">
          {current && <p className="m-0 mb-3 text-[14px] text-ink-2">The current food stays in the history, ending on the day this one starts.</p>}
          <button className="btn btn-primary" disabled={busy || (!brand.trim() && !product.trim())}>{busy ? 'Saving…' : 'Save food'}</button>
          <ErrorText text={error} />
        </div>
      </form>
    </Panel>
  );
}
