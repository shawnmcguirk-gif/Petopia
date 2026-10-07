// Household (spec sec 7, 8.2, 9.4; S7, A26): who has Petopia, everyone's role on each animal, habitats and contacts.
// What a person may change is decided by the engine (admins give household access; an animal's Owner changes its
// roles, and the last Owner can never leave; Owners / Primary carers add habitats and contacts) -- the screen only
// shows the controls the engine will accept, and shows the engine's answer when it refuses.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, get, post, type Animal, type Household as H, type Role } from './api';
import { AddButton, Card, ErrorText, Field, Panel, Section } from './ui';
import { ROLE_WORDS } from './words';

const ROLES: Role[] = ['OWNER', 'PRIMARY_CARER', 'FAMILY', 'VIEWER'];
const HABITAT_KINDS = ['HOME', 'GARDEN', 'POND', 'AQUARIUM', 'FEEDER', 'NEST_BOX', 'TERRARIUM', 'STABLE', 'OTHER'];
const CONTACT_KINDS: Record<string, string> = { VET_PRACTICE: 'Vet practice', VET_PERSON: 'Vet', EMERGENCY_VET: 'Emergency vet', BREEDER: 'Breeder', RESCUE: 'Rescue', INSURER: 'Insurer', GROOMER: 'Groomer', KENNEL: 'Kennel', PERSON: 'Person', WILDLIFE_RESCUE: 'Wildlife rescue' };
const cap = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

export function HouseholdScreen({ animals, onChanged }: { animals: Animal[]; onChanged?: () => void }) {
  const [h, setH] = useState<H | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<'member' | 'habitat' | 'contact' | null>(null);
  const load = useCallback(async () => {
    try { setH(await get<H>('api/household')); } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not load the household.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { const r = await fn(); if (r && typeof r === 'object' && 'members' in r) setH(r as H); else await load(); onChanged?.(); } catch (e) { setError(e instanceof ApiError ? e.message : 'That did not work.'); }
  };
  if (!h) return <main className="mx-auto max-w-3xl px-4 pt-6 pb-28">{error ? <ErrorText text={error} /> : <p className="text-ink-2" aria-busy="true">Loading…</p>}</main>;
  const owns = (id: number) => animals.find((a) => a.id === id)?.can.includes('MANAGE_ROLES') ?? false;
  return (
    <main className="mx-auto max-w-3xl px-4 pb-28 sm:px-6">
      <ErrorText text={error} />
      <Section title="People" action={h.me.admin && form !== 'member' ? <AddButton label="Give access" onClick={() => setForm('member')} /> : undefined}>
        {form === 'member' && <MemberForm onClose={() => setForm(null)} onSave={(b) => run(async () => { const r = await post<H>('api/household/members', b); setForm(null); return r; })} />}
        <Card className="divide-y divide-line overflow-hidden">
          {h.members.map((m) => (
            <div key={m.member_name} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="m-0 font-semibold">{m.display_name ?? m.member_name}{m.member_name === h.me.member ? <span className="font-normal text-ink-2"> · you</span> : null}</p>
                <p className="m-0 text-[14px] text-ink-2">{[m.display_name ? m.member_name : null, m.admin ? 'admin' : null, m.is_child ? 'child' : null].filter(Boolean).join(' · ')}</p>
              </div>
              {h.me.admin && m.member_name !== h.me.member && (
                <button type="button" className="btn min-h-10 shrink-0 px-3 text-[14px]" onClick={() => { if (window.confirm(`Take Petopia access away from ${m.display_name ?? m.member_name}?`)) void run(() => post<H>('api/household/members/revoke', { member_name: m.member_name })); }}>Remove</button>
              )}
            </div>
          ))}
        </Card>
      </Section>

      {h.animals.map((a) => (
        <Section key={a.id} title={`Roles · ${a.name}`}>
          <Card className="divide-y divide-line overflow-hidden">
            {a.roles.map((r) => (
              <div key={r.member_name} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <p className="m-0 min-w-0 truncate">{h.members.find((m) => m.member_name === r.member_name)?.display_name ?? r.member_name}</p>
                {owns(a.id) ? (
                  <select aria-label={`${r.member_name}'s role for ${a.name}`} className="field w-44 shrink-0" value={r.role}
                    onChange={(e) => void run(() => post<H>(`api/animals/${a.id}/roles`, { member_name: r.member_name, role: e.target.value }))}>
                    {ROLES.map((x) => <option key={x} value={x}>{ROLE_WORDS[x]}</option>)}
                  </select>
                ) : <span className="text-[15px] text-ink-2">{ROLE_WORDS[r.role]}{r.explicit ? '' : ' (default)'}</span>}
              </div>
            ))}
          </Card>
          {owns(a.id) && <p className="m-0 mt-2 text-[13px] text-ink-2">Every animal keeps at least one Owner.</p>}
        </Section>
      ))}

      <Section title="Habitats" action={h.me.manages && form !== 'habitat' ? <AddButton label="Add" onClick={() => setForm('habitat')} /> : undefined}>
        {form === 'habitat' && <HabitatForm habitats={h.habitats} onClose={() => setForm(null)} onSave={(b) => run(async () => { const r = await post<H>('api/habitats', b); setForm(null); return r; })} />}
        <Card className="divide-y divide-line overflow-hidden">
          {h.habitats.map((x) => <p key={x.id} className="m-0 px-4 py-2.5">{x.name} <span className="text-ink-2">· {cap(x.kind)}{x.parent_id ? ` in ${h.habitats.find((p) => p.id === x.parent_id)?.name ?? ''}` : ''}</span></p>)}
        </Card>
      </Section>

      {(h.contacts.length > 0 || h.me.manages) && (
        <Section title="Contacts" action={h.me.manages && form !== 'contact' ? <AddButton label="Add" onClick={() => setForm('contact')} /> : undefined}>
          {form === 'contact' && <ContactForm onClose={() => setForm(null)} onSave={(b) => run(async () => { await post('api/contacts', b); setForm(null); return null; })} />}
          {h.contacts.length > 0 && (
            <Card className="divide-y divide-line overflow-hidden">
              {h.contacts.map((x) => <p key={x.id} className="m-0 px-4 py-2.5">{x.name} <span className="text-ink-2">· {CONTACT_KINDS[x.kind] ?? x.kind}{x.phone ? ` · ${x.phone}` : ''}</span></p>)}
            </Card>
          )}
        </Section>
      )}
    </main>
  );
}

function MemberForm({ onClose, onSave }: { onClose: () => void; onSave: (b: unknown) => Promise<void> }) {
  const [name, setName] = useState('');
  const [display, setDisplay] = useState('');
  const [child, setChild] = useState(false);
  const submit = (e: FormEvent) => { e.preventDefault(); void onSave({ member_name: name.trim(), display_name: display.trim() || null, is_child: child }); };
  return (
    <Panel title="Give someone Petopia" onClose={onClose}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Synapse name" hint="exactly as they sign in to Synapse"><input className="field" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Shown as (optional)"><input className="field" value={display} onChange={(e) => setDisplay(e.target.value)} /></Field>
        <label className="flex items-center gap-2 text-[15px]"><input type="checkbox" checked={child} onChange={(e) => setChild(e.target.checked)} />A child (same rights as their role)</label>
        <div className="sm:col-span-2"><button className="btn btn-primary" disabled={!name.trim()}>Give access</button></div>
      </form>
    </Panel>
  );
}
function HabitatForm({ habitats, onClose, onSave }: { habitats: H['habitats']; onClose: () => void; onSave: (b: unknown) => Promise<void> }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('GARDEN');
  const [parent, setParent] = useState<number | ''>('');
  const submit = (e: FormEvent) => { e.preventDefault(); void onSave({ name: name.trim(), kind, parent_id: parent || null }); };
  return (
    <Panel title="Add a habitat" onClose={onClose}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-3">
        <Field label="Name"><input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Feeder by the shed" /></Field>
        <Field label="Kind"><select className="field" value={kind} onChange={(e) => setKind(e.target.value)}>{HABITAT_KINDS.map((k) => <option key={k} value={k}>{cap(k)}</option>)}</select></Field>
        <Field label="Inside (optional)"><select className="field" value={parent} onChange={(e) => setParent(e.target.value ? Number(e.target.value) : '')}><option value="">—</option>{habitats.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
        <div className="sm:col-span-3"><button className="btn btn-primary" disabled={!name.trim()}>Add habitat</button></div>
      </form>
    </Panel>
  );
}
function ContactForm({ onClose, onSave }: { onClose: () => void; onSave: (b: unknown) => Promise<void> }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('VET_PRACTICE');
  const [phone, setPhone] = useState('');
  const submit = (e: FormEvent) => { e.preventDefault(); void onSave({ name: name.trim(), kind, phone: phone.trim() || null }); };
  return (
    <Panel title="Add a contact" onClose={onClose}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-3">
        <Field label="Name"><input className="field" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Kind"><select className="field" value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(CONTACT_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Phone"><input className="field" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        <div className="sm:col-span-3"><button className="btn btn-primary" disabled={!name.trim()}>Add contact</button></div>
      </form>
    </Panel>
  );
}
