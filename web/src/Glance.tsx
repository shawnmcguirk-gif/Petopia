// Overview "at a glance" (spec sec 8.3 Overview: weight sparkline, current food, current medication; S3/S4). Each
// card appears only when there is real data behind it. The vet practice card links the phone number.
import { Phone, Pill, Scale, Soup, Stethoscope } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, get, patch, post, type Animal, type Contact, type Measurement } from './api';
import { changeText, niceDate, todayIso } from './format';
import { Card, ErrorText, Field, Section } from './ui';
import { WeightChart } from './WeightChart';
import { foodLine } from './words';

function Tile({ icon, title, href, children }: { icon: ReactNode; title: string; href?: string; children: ReactNode }) {
  const body = (
    <Card className="h-full p-4">
      <p className="m-0 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[.06em] text-ink-2">{icon}{title}</p>
      <div className="mt-2">{children}</div>
    </Card>
  );
  return href ? <a href={href} className="block text-ink no-underline">{body}</a> : body;
}

export function Glance({ a, onChange }: { a: Animal; onChange: (a: Animal) => void }) {
  const [weights, setWeights] = useState<Measurement[]>([]);
  const w = a.latest_weight;
  useEffect(() => {
    if (!w) return;
    let live = true;
    get<Measurement[]>(`api/animals/${a.id}/measurements?measure=weight`).then((m) => { if (live) setWeights(m); }).catch(() => undefined);
    return () => { live = false; };
  }, [a.id, w]);
  const icon = 'h-4 w-4';
  const any = w || a.current_food || a.current_medication.length || a.vet;
  return (
    <>
      {any && (
        <Section title="At a glance">
          <div className="grid gap-3 sm:grid-cols-2">
            {w && (
              <Tile icon={<Scale aria-hidden className={icon} strokeWidth={1.75} />} title="Weight" href={`#/animals/${a.id}/health`}>
                <p className="m-0 text-[24px] font-semibold tabular-nums">{Number(w.kg)} kg</p>
                <p className="m-0 text-[14px] text-ink-2">{niceDate(w.on)}{changeText(w.change_kg, 'kg') ? ` · ${changeText(w.change_kg, 'kg')} since last` : ''}</p>
                {weights.length > 1 && <div className="mt-2"><WeightChart compact points={weights.map((x) => ({ on: x.on, value: Number(x.value) }))} today={todayIso()} /></div>}
              </Tile>
            )}
            {a.current_food && (
              <Tile icon={<Soup aria-hidden className={icon} strokeWidth={1.75} />} title="Food" href={`#/animals/${a.id}/care`}>
                <p className="m-0 font-semibold">{[a.current_food.brand, a.current_food.product].filter(Boolean).join(' ')}</p>
                <p className="m-0 text-[14px] text-ink-2">{foodLine({ ...a.current_food, brand: null, product: null })}</p>
              </Tile>
            )}
            {a.current_medication.length > 0 && (
              <Tile icon={<Pill aria-hidden className={icon} strokeWidth={1.75} />} title="Current medication" href={`#/animals/${a.id}/health`}>
                <ul className="m-0 list-none p-0">
                  {a.current_medication.map((m) => <li key={m.medication_id}><strong>{m.product_name}</strong>{m.dose || m.frequency ? <span className="text-ink-2"> · {[m.dose, m.frequency].filter(Boolean).join(', ')}</span> : null}</li>)}
                </ul>
              </Tile>
            )}
            {a.vet && (
              <Tile icon={<Stethoscope aria-hidden className={icon} strokeWidth={1.75} />} title="Vet practice">
                <p className="m-0 font-semibold">{a.vet.name}</p>
                {a.vet.phone && <a href={`tel:${a.vet.phone.replace(/\s+/g, '')}`} className="mt-1 inline-flex items-center gap-1.5 text-gold"><Phone aria-hidden className="h-4 w-4" strokeWidth={1.75} />{a.vet.phone}</a>}
              </Tile>
            )}
          </div>
        </Section>
      )}
      {!a.vet && a.can.includes('EDIT_PROFILE') && <VetPracticeSetter a={a} onChange={onChange} />}
    </>
  );
}

/** Sets the usual vet practice: pick an existing contact or add a new one (name + phone). */
function VetPracticeSetter({ a, onChange }: { a: Animal; onChange: (a: Animal) => void }) {
  const [open, setOpen] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [pick, setPick] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) get<Contact[]>('api/contacts').then((c) => setContacts(c.filter((x) => x.kind === 'VET_PRACTICE' || x.kind === 'EMERGENCY_VET'))).catch(() => undefined);
  }, [open]);
  if (!open) return <p className="mt-6"><button type="button" className="btn" onClick={() => setOpen(true)}><Stethoscope aria-hidden className="h-4 w-4" strokeWidth={1.75} />Add {a.name}’s vet practice</button></p>;
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const id = pick ? Number(pick) : (await post<Contact>('api/contacts', { kind: 'VET_PRACTICE', name, phone })).id;
      onChange(await patch<Animal>(`api/animals/${a.id}`, { vet_contact_id: id }));
    } catch (er) {
      setError(er instanceof ApiError ? er.message : 'That could not be saved.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title="Vet practice">
      <Card className="p-4">
        <form onSubmit={submit} className="grid gap-4">
          {contacts.length > 0 && (
            <Field label="Choose a practice">
              <select className="field" value={pick} onChange={(e) => setPick(e.target.value)}><option value="">A new practice…</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            </Field>
          )}
          {!pick && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Practice name"><input className="field" value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="Phone (optional)"><input className="field" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
            </div>
          )}
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={busy || (!pick && !name.trim())}>{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
          </div>
          <ErrorText text={error} />
        </form>
      </Card>
    </Section>
  );
}
