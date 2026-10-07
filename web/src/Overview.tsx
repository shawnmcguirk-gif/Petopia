// An animal's Overview (spec sec 8.3, first tab): photo, identity, and only the details that are actually known.
// Below it, "at a glance": current weight (with a sparkline), food, medication and the vet practice -- each only when
// it is recorded. Timeline, Health and Care & food are the other tabs (AnimalPage.tsx).
import { Camera, Pencil } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError, post, type Animal } from './api';
import { AnimalPhoto } from './AnimalPhoto';
import { StatusChip } from './AnimalCard';
import { clearNotice, peekNotice } from './AnimalForm';
import { photoForUpload } from './photo';
import { Glance } from './Glance';
import { NEUTER_WORDS, SEX_WORDS, summaryLine } from './words';

const ROLE_WORDS: Record<Animal['my_role'], string> = { OWNER: 'Owner', PRIMARY_CARER: 'Primary carer', FAMILY: 'Family member', VIEWER: 'Viewer' };

export function Overview({ a, onChange }: { a: Animal; onChange: (a: Animal) => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(peekNotice);
  useEffect(() => clearNotice(), []);

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setMsg(null);
    try {
      onChange(await post<Animal>(`api/animals/${a.id}/photo`, { dataBase64: await photoForUpload(file) }));
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'The photo could not be saved. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const rows: [string, string | null][] = [
    ['Species', a.species],
    ['Breed', a.breed],
    ['Born', a.born ? (a.born_precision === 'YEAR' ? `${a.born} (year only)` : a.born) : null],
    ['Sex', SEX_WORDS[a.sex]],
    ['Neutered', NEUTER_WORDS[a.neuter_status]],
    ['Colour and markings', a.colour_markings],
    ['Microchip', a.microchip],
    ['Lives at', a.habitat],
  ];
  const known = rows.filter((r): r is [string, string] => !!r[1]);

  return (
    <main className="mx-auto max-w-3xl px-4 pb-24 pt-4 sm:px-6">
      <div className="relative">
        <AnimalPhoto path={a.photo} name={a.name} className="aspect-[4/3] w-full shadow-[var(--shadow)] sm:aspect-[16/10]" rounded="rounded-3xl" />
        {a.can.includes('ADD_MEDIA') && (
          <label className={`btn absolute bottom-3 right-3 cursor-pointer border-white/25 bg-black/55 text-white backdrop-blur ${busy ? 'pointer-events-none opacity-60' : ''}`}>
            <Camera aria-hidden className="h-5 w-5" strokeWidth={1.75} />
            {busy ? 'Saving…' : a.photo ? 'Change photo' : 'Add photo'}
            <input type="file" accept="image/*" className="sr-only" disabled={busy} onChange={(e) => void upload(e.target.files?.[0])} />
          </label>
        )}
      </div>

      {msg && <p role="status" className="m-0 mt-4 rounded-xl border border-line-strong bg-surface-2 px-4 py-3 text-[15px]">{msg}</p>}

      <div className="mt-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="name m-0 text-[40px] leading-[1.05]">{a.name}</h2>
          {a.nickname && <p className="m-0 mt-1 text-ink-2">“{a.nickname}”</p>}
          <p className="m-0 mt-2 text-[17px] text-ink-2">{summaryLine(a)}</p>
          {a.health_status && <div className="mt-3"><StatusChip status={a.health_status} /></div>}
        </div>
        {a.can.includes('EDIT_PROFILE') && (
          <a href={`#/animals/${a.id}/edit`} className="btn shrink-0 no-underline" aria-label={`Edit ${a.name}'s details`}>
            <Pencil aria-hidden className="h-4 w-4" strokeWidth={1.75} />Edit
          </a>
        )}
      </div>

      <Glance a={a} onChange={onChange} />

      {known.length > 0 && (
        <section aria-labelledby="about" className="mt-8">
          <h3 id="about" className="m-0 mb-3 text-[13px] font-semibold uppercase tracking-[.08em] text-ink-2">About</h3>
          <dl className="m-0 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {known.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 px-4 py-3.5">
                <dt className="text-ink-2">{k}</dt>
                <dd className="m-0 text-right font-medium">{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <p className="mt-8 text-[13px] text-ink-2">You are {a.my_role === 'OWNER' ? 'an' : 'a'} {ROLE_WORDS[a.my_role].toLowerCase()} for {a.name}.</p>
    </main>
  );
}
