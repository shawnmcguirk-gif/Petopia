// The Household screen (spec sec 7, 8.2, 9.4 "Household"; slice S7; A26): who has Petopia, their role on each animal,
// habitats and contacts -- and the changes behind it:
//   - household access (sec 7.1 layer 1): an admin (PETOPIA_ADMINS) grants or takes it away; never their own;
//   - roles per animal (layer 2): Owner only; the last Owner can never be removed or weakened (access.ts, under a lock);
//   - habitats: added by an Owner / Primary carer of any animal (the people who manage care).
import { grantHousehold, isAdmin, managesAny, revokeHousehold, ROLES, setAnimalRole, endAnimalRole, type Role } from './access.js';
import type { Client } from './db.js';
import { conflict, forbidden } from './errors.js';
import { listContacts, type ContactView } from './contacts.js';
import { listHabitats, type HabitatView } from './habitats.js';
import { insertRow } from './provenance.js';
import { S, bodyChecker } from './validate.js';

export interface HouseholdView {
  me: { member: string; admin: boolean; manages: boolean };
  members: { member_name: string; display_name: string | null; is_child: boolean; granted_at: string; granted_by: string; admin: boolean }[];
  animals: { id: number; name: string; status: string; roles: { member_name: string; role: Role; explicit: boolean }[] }[];
  habitats: HabitatView[];
  contacts: ContactView[];
}

export async function household(c: Client, ws: number, member: string): Promise<HouseholdView> {
  const members = (await c.query<{ member_name: string; display_name: string | null; is_child: boolean | null; granted_at: string; granted_by: string }>(
    `SELECT g.member_name, m.display_name, m.is_child, g.granted_at::text, g.granted_by FROM core.access_grant g
       LEFT JOIN core.member m ON m.workspace_id = g.workspace_id AND m.member_name = g.member_name
      WHERE g.workspace_id = $1 AND g.revoked_at IS NULL ORDER BY lower(g.member_name)`, [ws])).rows;
  const animals = (await c.query<{ id: number; name: string; status: string }>("SELECT animal_id::int AS id, name, status FROM animal.animal ORDER BY status = 'ACTIVE' DESC, lower(name)")).rows;
  const roles = (await c.query<{ a: number; member_name: string; role: Role }>('SELECT animal_id::int AS a, member_name, role FROM core.animal_role WHERE to_on IS NULL')).rows;
  return {
    me: { member, admin: isAdmin(member), manages: await managesAny(c, member) },
    members: members.map((m) => ({ ...m, is_child: m.is_child ?? false, admin: isAdmin(m.member_name) })),
    animals: animals.map((a) => ({
      ...a,
      // everyone with household access and no role row is a Family member of that animal (sec 7.1)
      roles: members.map((m) => {
        const r = roles.find((x) => x.a === a.id && x.member_name === m.member_name);
        return { member_name: m.member_name, role: r?.role ?? 'FAMILY', explicit: !!r };
      }),
    })),
    habitats: await listHabitats(c),
    contacts: await listContacts(c),
  };
}

const checkMember = bodyChecker<{ member_name: string; display_name?: string | null; is_child?: boolean }>(S.object({
  member_name: { type: 'string', minLength: 1, maxLength: 80 }, display_name: S.text(80), is_child: { type: 'boolean' },
}, ['member_name']));
/** Admin only: give a Synapse member access to Petopia in this household. */
export async function addMember(c: Client, ws: number, actor: string, body: unknown): Promise<HouseholdView> {
  const b = checkMember(body);
  const name = b.member_name.trim();
  await grantHousehold(c, ws, name, actor);
  await c.query(
    `INSERT INTO core.member (workspace_id, member_name, display_name, is_child, created_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (workspace_id, member_name) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, core.member.display_name), is_child = EXCLUDED.is_child`,
    [ws, name, b.display_name?.trim() || null, b.is_child ?? false, actor]);
  return household(c, ws, actor);
}

export async function removeMember(c: Client, ws: number, actor: string, member: string): Promise<HouseholdView> {
  await revokeHousehold(c, ws, member, actor);
  return household(c, ws, actor);
}

const checkRole = bodyChecker<{ member_name: string; role: Role | null }>(S.object({
  member_name: { type: 'string', minLength: 1, maxLength: 80 }, role: { type: ['string', 'null'], enum: [...ROLES, null] },
}, ['member_name', 'role']));
/** Owner only (sec 7.2 "Change roles"). role null = remove their role (they become Family by default). Last-Owner rule. */
export async function changeRole(c: Client, ws: number, animalId: number, actor: string, body: unknown): Promise<HouseholdView> {
  const b = checkRole(body);
  if (b.role === null) await endAnimalRole(c, ws, animalId, b.member_name.trim(), actor);
  else await setAnimalRole(c, ws, animalId, b.member_name.trim(), b.role, actor);
  return household(c, ws, actor);
}

const HABITAT_KINDS = ['HOME', 'GARDEN', 'POND', 'AQUARIUM', 'FEEDER', 'NEST_BOX', 'TERRARIUM', 'STABLE', 'OTHER'] as const;
const checkHabitat = bodyChecker<{ name: string; kind: string; parent_id?: number | null }>(S.object({
  name: { type: 'string', minLength: 1, maxLength: 60 }, kind: S.oneOf(HABITAT_KINDS), parent_id: S.id(),
}, ['name', 'kind']));
export async function addHabitat(c: Client, ws: number, actor: string, body: unknown): Promise<HouseholdView> {
  if (!(await managesAny(c, actor))) throw forbidden('only an Owner or Primary carer can add a habitat');
  const b = checkHabitat(body);
  const name = b.name.trim();
  if (!name) throw conflict('a habitat needs a name');
  if (b.parent_id && !(await c.query('SELECT 1 FROM core.habitat WHERE habitat_id = $1 AND retired_at IS NULL', [b.parent_id])).rowCount) throw conflict('that parent habitat is not in this household');
  await insertRow(c, 'core.habitat', 'habitat_id', { workspace_id: ws, name, kind: b.kind, parent_id: b.parent_id ?? null, created_by: actor });
  return household(c, ws, actor);
}
