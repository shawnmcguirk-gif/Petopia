// Add an animal (spec sec 9.4): name + species (+ breed) first; a photo; the rest optional and tucked away.
// The same form edits an existing animal's basic profile (Owner / Primary carer; the engine checks).
import { Camera, ChevronDown } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { ApiError, patch, post, type Animal } from './api';
import { photoForUpload } from './photo';
import { go } from './route';

export let notice: string | null = null; // a message carried to the next screen (e.g. "saved, but the photo failed")
export const peekNotice = (): string | null => notice;
export const clearNotice = (): void => { notice = null; };

const SPECIES = [{ code: 'dog', label: 'Dog' }, { code: 'cat', label: 'Cat' }] as const;

export function AnimalForm({ existing, onSaved }: { existing?: Animal; onSaved: (a: Animal) => void }) {
  const ids = useId();
  const [name, setName] = useState(existing?.name ?? '');
  const [species, setSpecies] = useState(existing?.module ?? '');
  const [breed, setBreed] = useState(existing?.breed ?? '');
  const [born, setBorn] = useState(existing?.born ?? '');
  const [sex, setSex] = useState<string>(existing?.sex ?? 'UNKNOWN');
  const [neuter, setNeuter] = useState<string>(existing?.neuter_status ?? 'UNKNOWN');
  const [colour, setColour] = useState(existing?.colour_markings ?? '');
  const [chip, setChip] = useState(existing?.microchip ?? '');
  const [health, setHealth] = useState<string>(existing?.health_status ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [more, setMore] = useState(!!existing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const u = URL.createObjectURL(file);
    setPreview(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  const canSave = name.trim().length > 0 && species !== '' && !busy;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    const details = { breed, born, sex, neuter_status: neuter, colour_markings: colour, microchip: chip };
    try {
      if (existing) {
        const body: Record<string, unknown> = { name, ...details };
        if ((existing.health_status ?? '') !== health) body.health_status = health || null;
        onSaved(await patch<Animal>(`api/animals/${existing.id}`, body));
        return;
      }
      const a = await post<Animal>('api/animals', { name, species, ...details });
      if (file) {
        try {
          await post<Animal>(`api/animals/${a.id}/photo`, { dataBase64: await photoForUpload(file) });
        } catch (pe) {
          notice = `${a.name} is added, but the photo could not be saved${pe instanceof ApiError ? `: ${pe.message}` : ''}. You can add it from here.`;
        }
      }
      onSaved(a);
      go(`/animals/${a.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That could not be saved. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const label = 'mb-1.5 block text-[14px] font-medium text-ink-2';
  return (
    <form onSubmit={submit} className="mx-auto max-w-xl space-y-6 px-4 pb-24 pt-6">
      <div>
        <label htmlFor={`${ids}-name`} className={label}>Name</label>
        <input id={`${ids}-name`} className="field name !text-[22px]" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" required />
      </div>

      {!existing && (
        <div>
          <span className={label} id={`${ids}-sp`}>Species</span>
          <div className="seg" role="group" aria-labelledby={`${ids}-sp`}>
            {SPECIES.map((s) => <button key={s.code} type="button" aria-pressed={species === s.code} onClick={() => setSpecies(s.code)}>{s.label}</button>)}
          </div>
        </div>
      )}

      <div className="grid gap-6 sm:grid-cols-2">
        <div>
          <label htmlFor={`${ids}-breed`} className={label}>Breed <span className="font-normal opacity-70">(optional)</span></label>
          <input id={`${ids}-breed`} className="field" value={breed} onChange={(e) => setBreed(e.target.value)} maxLength={80} placeholder={species === 'cat' ? 'e.g. Domestic shorthair' : 'e.g. Shih Tzu'} />
        </div>
        <div>
          <label htmlFor={`${ids}-born`} className={label}>Born <span className="font-normal opacity-70">(optional)</span></label>
          <input id={`${ids}-born`} className="field" value={born} onChange={(e) => setBorn(e.target.value)} inputMode="numeric" placeholder="2018, 2018-03 or 2018-03-14" aria-describedby={`${ids}-born-h`} />
          <p id={`${ids}-born-h`} className="m-0 mt-1.5 text-[13px] text-ink-2">Just the year is fine — the age will say "about".</p>
        </div>
      </div>

      {!existing && (
        <div>
          <span className={label}>Photo <span className="font-normal opacity-70">(optional)</span></span>
          <label className="flex cursor-pointer items-center gap-4 rounded-2xl border border-dashed border-line-strong bg-surface-2 p-3">
            {preview ? <img src={preview} alt="Chosen photo" className="h-20 w-20 rounded-xl object-cover" /> : <span className="flex h-20 w-20 items-center justify-center rounded-xl bg-surface"><Camera aria-hidden className="h-7 w-7 text-ink-2" strokeWidth={1.5} /></span>}
            <span className="text-[15px]">{file ? 'Change photo' : 'Take or choose a photo'}<span className="block text-[13px] text-ink-2">Location and camera details are removed before it is kept.</span></span>
            <input type="file" accept="image/*" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
        </div>
      )}

      <div className="rounded-2xl border border-line">
        <button type="button" onClick={() => setMore(!more)} aria-expanded={more} className="flex w-full items-center justify-between rounded-2xl bg-transparent px-4 py-3.5 text-left text-[15px] font-semibold text-ink">
          More details
          <ChevronDown aria-hidden className={`h-5 w-5 text-ink-2 transition-transform ${more ? 'rotate-180' : ''}`} strokeWidth={1.75} />
        </button>
        {more && (
          <div className="grid gap-5 px-4 pb-5 sm:grid-cols-2">
            <div>
              <label htmlFor={`${ids}-sex`} className={label}>Sex</label>
              <select id={`${ids}-sex`} className="field" value={sex} onChange={(e) => setSex(e.target.value)}>
                <option value="UNKNOWN">Not set</option><option value="FEMALE">Female</option><option value="MALE">Male</option>
              </select>
            </div>
            <div>
              <label htmlFor={`${ids}-neuter`} className={label}>Neutered</label>
              <select id={`${ids}-neuter`} className="field" value={neuter} onChange={(e) => setNeuter(e.target.value)}>
                <option value="UNKNOWN">Not set</option><option value="NEUTERED">Yes</option><option value="ENTIRE">No</option>
              </select>
            </div>
            <div>
              <label htmlFor={`${ids}-colour`} className={label}>Colour and markings</label>
              <input id={`${ids}-colour`} className="field" value={colour} onChange={(e) => setColour(e.target.value)} maxLength={200} />
            </div>
            <div>
              <label htmlFor={`${ids}-chip`} className={label}>Microchip number</label>
              <input id={`${ids}-chip`} className="field" value={chip} onChange={(e) => setChip(e.target.value)} inputMode="numeric" maxLength={23} />
            </div>
            {existing?.can.includes('EDIT_PROFILE') && (
              <div className="sm:col-span-2">
                <label htmlFor={`${ids}-health`} className={label}>Health status</label>
                <select id={`${ids}-health`} className="field" value={health} onChange={(e) => setHealth(e.target.value)}>
                  <option value="">Not set</option><option value="HEALTHY">Healthy</option><option value="UNDER_TREATMENT">Under treatment</option><option value="NEEDS_ATTENTION">Needs attention</option>
                </select>
                <p className="m-0 mt-1.5 text-[13px] text-ink-2">Set by you, never worked out by the app.</p>
              </div>
            )}
          </div>
        )}
      </div>

      {error && <p role="alert" className="m-0 rounded-xl border border-red/40 bg-surface-2 px-4 py-3 text-[15px] text-red">{error}</p>}

      <div className="flex gap-3">
        <button type="submit" className="btn btn-primary flex-1" disabled={!canSave}>{busy ? 'Saving…' : existing ? 'Save' : 'Add animal'}</button>
        <a href={existing ? `#/animals/${existing.id}` : '#/'} className="btn no-underline">Cancel</a>
      </div>
    </form>
  );
}
