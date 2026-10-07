// Health (spec sec 8.3; S3 weight + S4 records): weight, medication, vet visits, vaccinations, treatments, conditions,
// allergies, procedures, lab results. A section with nothing in it is hidden; one "Add a record" chooser covers them.
// Rows waiting for a check show that badge, and an Owner / Primary carer can Confirm or say "Not right".
// Petopia shows only what was recorded -- never a computed health status or a breed comparison (sec 9.3, 10.3).
import { useCallback, useEffect, useState } from 'react';
import { ApiError, get, post, type Animal, type Contact, type Health, type RecordRow } from './api';
import { niceDate } from './format';
import { MedicationSection } from './Medications';
import { KINDS, type KindDef } from './recordDefs';
import { RecordForm } from './RecordForm';
import { BadgeChip, Card, ErrorText, Section } from './ui';
import { WeightSection } from './WeightSection';

type Editing = { kind: KindDef; row?: RecordRow } | null;

export function HealthTab({ a, onChanged }: { a: Animal; onChanged: () => void }) {
  const [h, setH] = useState<Health | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const load = useCallback(async () => {
    try {
      setH(await get<Health>(`api/animals/${a.id}/health`));
      setContacts(await get<Contact[]>('api/contacts'));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the health record.');
    }
  }, [a.id]);
  useEffect(() => { void load(); }, [load]);
  const changed = () => { void load(); onChanged(); };

  const canWrite = a.can.includes('PROPOSE_RECORDS');
  const confirms = a.can.includes('CONFIRM_RECORDS');

  async function act(kind: string, id: number, what: 'confirm' | 'dispute') {
    setError(null);
    try { await post(`api/animals/${a.id}/records/${kind}/${id}/${what}`); changed(); } catch (e) { setError(e instanceof ApiError ? e.message : 'That did not work.'); }
  }

  if (!h) return error ? <ErrorText text={error} /> : <p className="text-ink-2" aria-busy="true">Loading…</p>;
  const visits = h.records.vet_visit ?? [];
  const nothing = KINDS.every((k) => !(h.records[k.code] ?? []).length) && !h.medications.medicines.length && !h.measurements.length;

  return (
    <div>
      <ErrorText text={error} />
      {canWrite && (
        <div className="mt-6">
          <label className="block">
            <span className="mb-1.5 block text-[14px] font-medium">Add a record</span>
            <select className="field" value="" onChange={(e) => { const k = KINDS.find((x) => x.code === e.target.value); if (k) setEditing({ kind: k }); }}>
              <option value="">Choose what to add…</option>
              {KINDS.map((k) => <option key={k.code} value={k.code}>{k.one}</option>)}
            </select>
          </label>
          {!confirms && <p className="m-0 mt-2 text-[14px] text-ink-2">What you add waits for an Owner or Primary carer to check it.</p>}
        </div>
      )}
      {editing && (
        <div className="mt-4">
          <RecordForm animalId={a.id} kind={editing.kind} existing={editing.row} contacts={contacts} visits={visits} confirms={confirms}
            onClose={() => setEditing(null)} onSaved={() => { setEditing(null); changed(); }} />
        </div>
      )}
      {nothing && !canWrite && <p className="mt-8 text-ink-2">Nothing has been recorded for {a.name} yet.</p>}

      <WeightSection a={a} readings={h.measurements} onSaved={changed} />
      <MedicationSection a={a} meds={h.medications} onSaved={changed} />
      {KINDS.map((k) => {
        const rows = h.records[k.code] ?? [];
        if (!rows.length) return null;
        return (
          <Section key={k.code} title={k.title}>
            <Card className="divide-y divide-line overflow-hidden">
              {rows.map((r) => (
                <div key={r.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="m-0 font-semibold">{k.headline(r.fields)}</p>
                      {k.lines(r.fields).map((l) => <p key={l} className="m-0 text-[15px] text-ink-2">{l}</p>)}
                      <p className="m-0 mt-1 text-[13px] text-ink-2">{[niceDate(r.fields[k.date] as string | null), r.by].filter(Boolean).join(' · ')}</p>
                    </div>
                    <BadgeChip badge={r.badge} />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {r.status === 'PROPOSED' && confirms && (
                      <>
                        <button type="button" className="btn btn-primary min-h-10 px-3 text-[14px]" onClick={() => void act(k.code, r.id, 'confirm')}>Confirm</button>
                        <button type="button" className="btn min-h-10 px-3 text-[14px]" onClick={() => void act(k.code, r.id, 'dispute')}>Not right</button>
                      </>
                    )}
                    {canWrite && <button type="button" className="btn min-h-10 border-0 px-2 text-[14px] text-ink-2" onClick={() => setEditing({ kind: k, row: r })}>Correct</button>}
                  </div>
                </div>
              ))}
            </Card>
          </Section>
        );
      })}
    </div>
  );
}
