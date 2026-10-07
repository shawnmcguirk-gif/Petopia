// Vet appointments (spec sec 6 "Calendar detail"; S6, A25). Booking puts it on the Primary carer's Synapse calendar
// (else the Owner's); moving or cancelling it here moves or cancels that event. If the calendar can't be reached the
// appointment is still saved and says "not on a calendar", with a retry. Edits made in Google do not come back.
import { useState, type FormEvent } from 'react';
import { ApiError, patch, post, type Animal, type Appointment } from './api';
import { niceDate, todayIso } from './format';
import { AddButton, Card, ErrorText, Field, Panel, Section } from './ui';

const CAL: Record<string, string> = { SAVED: 'On the Synapse calendar', ON_GOOGLE: 'On the calendar (and Google)', FAILED: 'Not on a calendar' };

export function Appointments({ a, list, onChanged }: { a: Animal; list: Appointment[]; onChanged: () => void }) {
  const manage = a.can.includes('MANAGE_CARE');
  const [open, setOpen] = useState<Appointment | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const booked = list.filter((x) => x.state === 'BOOKED');
  if (!manage && booked.length === 0) return null;
  const run = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); onChanged(); } catch (e) { setError(e instanceof ApiError ? e.message : 'That did not work — try again.'); } };
  return (
    <Section title="Vet appointments" action={manage && !open ? <AddButton label="Book" onClick={() => setOpen('new')} /> : undefined}>
      {open && <ApptForm a={a} existing={open === 'new' ? null : open} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); onChanged(); }} />}
      {booked.length > 0 && (
        <Card className="divide-y divide-line overflow-hidden">
          {booked.map((x) => (
            <div key={x.id} className="px-4 py-3">
              <p className="m-0 font-semibold">{niceDate(x.starts_on)}{x.starts_time ? ` · ${x.starts_time}` : ''}{x.reason ? ` · ${x.reason}` : ''}</p>
              <p className={`m-0 text-[14px] ${x.calendar_state === 'FAILED' ? 'text-amber' : 'text-ink-2'}`}>{x.contact ? `${x.contact} · ` : ''}{x.calendar_state ? CAL[x.calendar_state] : 'Not sent to a calendar'}{x.calendar_persona && x.calendar_state !== 'FAILED' ? ` (${x.calendar_persona})` : ''}</p>
              {manage && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" className="btn min-h-10 px-3 text-[14px]" onClick={() => setOpen(x)}>Move</button>
                  <button type="button" className="btn min-h-10 px-3 text-[14px]" onClick={() => void run(() => patch(`api/animals/${a.id}/appointments/${x.id}`, { state: 'CANCELLED' }))}>Cancel</button>
                  {x.calendar_state === 'FAILED' && <button type="button" className="btn min-h-10 px-3 text-[14px]" onClick={() => void run(() => post(`api/animals/${a.id}/appointments/${x.id}/calendar`))}>Try the calendar again</button>}
                </div>
              )}
            </div>
          ))}
        </Card>
      )}
      <ErrorText text={error} />
    </Section>
  );
}

function ApptForm({ a, existing, onClose, onSaved }: { a: Animal; existing: Appointment | null; onClose: () => void; onSaved: () => void }) {
  const [on, setOn] = useState(existing?.starts_on ?? '');
  const [time, setTime] = useState(existing?.starts_time ?? '');
  const [reason, setReason] = useState(existing?.reason ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = { starts_on: on, starts_time: time || null, reason: reason || null, ...(existing ? {} : a.vet ? { contact_id: a.vet.id } : {}) };
      if (existing) await patch(`api/animals/${a.id}/appointments/${existing.id}`, body);
      else await post(`api/animals/${a.id}/appointments`, body);
      onSaved();
    } catch (er) { setError(er instanceof ApiError ? er.message : 'The appointment could not be saved.'); } finally { setBusy(false); }
  }
  return (
    <Panel title={existing ? 'Move the appointment' : `Book a vet appointment for ${a.name}`} onClose={onClose}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-3">
        <Field label="Date"><input className="field" type="date" min={todayIso()} value={on} onChange={(e) => setOn(e.target.value)} required /></Field>
        <Field label="Time (optional)"><input className="field" type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
        <Field label="What for"><input className="field" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="annual vaccination" /></Field>
        <div className="sm:col-span-3">
          <button className="btn btn-primary" disabled={busy || !on}>{busy ? 'Saving…' : existing ? 'Move it' : 'Book it'}</button>
          <ErrorText text={error} />
        </div>
      </form>
    </Panel>
  );
}
