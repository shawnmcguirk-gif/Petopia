// Contacts (spec sec 3.7 core.contact): the vet practice, emergency vet, breeder, insurer... Household-wide, not per
// animal. Everyone in the household may see them; adding one needs Owner or Primary carer on at least one animal (the
// people who manage care). The Household screen (S7) will manage them fully.
import type { Client } from './db.js';
import { forbidden } from './errors.js';
import { insertRow } from './provenance.js';
import { S, bodyChecker } from './validate.js';

export const CONTACT_KINDS = ['VET_PRACTICE', 'VET_PERSON', 'EMERGENCY_VET', 'BREEDER', 'RESCUE', 'INSURER', 'GROOMER', 'KENNEL', 'PERSON', 'WILDLIFE_RESCUE'] as const;
export interface ContactView { id: number; kind: string; name: string; phone: string | null; email: string | null; address: string | null }

const checkNew = bodyChecker<{ kind: string; name: string; phone?: string | null; email?: string | null; address?: string | null }>(S.object({
  kind: S.oneOf(CONTACT_KINDS), name: { type: 'string', minLength: 1, maxLength: 120 }, phone: S.text(40), email: S.text(120), address: S.text(300),
}, ['kind', 'name']));

export async function listContacts(c: Client): Promise<ContactView[]> {
  const r = await c.query<ContactView & { id: string }>(
    'SELECT contact_id::text AS id, kind, name, phone, email, address FROM core.contact WHERE retired_at IS NULL ORDER BY kind, lower(name)',
  );
  return r.rows.map((x) => ({ ...x, id: Number(x.id) }));
}

export async function addContact(c: Client, ws: number, member: string, body: unknown): Promise<ContactView> {
  const managesAny = await c.query("SELECT 1 FROM core.animal_role WHERE member_name = $1 AND to_on IS NULL AND role IN ('OWNER','PRIMARY_CARER') LIMIT 1", [member]);
  if (!managesAny.rowCount) throw forbidden('only an Owner or Primary carer can add a contact');
  const b = checkNew(body);
  const t = (s: string | null | undefined) => (s ?? '').trim() || null;
  const name = b.name.trim();
  if (!name) throw forbidden('a contact needs a name');
  const id = await insertRow(c, 'core.contact', 'contact_id', { workspace_id: ws, kind: b.kind, name, phone: t(b.phone), email: t(b.email), address: t(b.address), created_by: member });
  return { id, kind: b.kind, name, phone: t(b.phone), email: t(b.email), address: t(b.address) };
}
