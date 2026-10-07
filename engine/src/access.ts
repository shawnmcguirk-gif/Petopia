// Two layers of access (spec sec 7.1, A5):
//   1. Household: core.access_grant (deny by default; no RLS, read before a workspace is chosen).
//   2. Per animal: core.animal_role -- OWNER / PRIMARY_CARER / FAMILY / VIEWER. A member with household access and no
//      role on an animal is FAMILY for it (the household default, sec 7.1).
// The role table of sec 7.2 is the pure `can()` below; every route asks it. The last-Owner rule (every animal keeps at
// least one Owner; the last Owner cannot remove or weaken themselves) is checked under a row lock, Vitalis-style.
import type { Client } from './db.js';
import { bad, conflict, forbidden, notFound } from './errors.js';

export const ROLES = ['OWNER', 'PRIMARY_CARER', 'FAMILY', 'VIEWER'] as const;
export type Role = (typeof ROLES)[number];
export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v);
export const DEFAULT_ROLE: Role = 'FAMILY';

/** The rows of sec 7.2, plus EDIT_PROFILE (basic profile and health status: Owner / Primary carer, sec 9.3). */
export const ACTIONS = {
  VIEW: ['OWNER', 'PRIMARY_CARER', 'FAMILY', 'VIEWER'],
  LOG_CARE: ['OWNER', 'PRIMARY_CARER', 'FAMILY'],
  ADD_MEDIA: ['OWNER', 'PRIMARY_CARER', 'FAMILY'], // photos, memories, our-note observations, weights
  DROP_DOCUMENTS: ['OWNER', 'PRIMARY_CARER', 'FAMILY'],
  PROPOSE_RECORDS: ['OWNER', 'PRIMARY_CARER', 'FAMILY'], // write a vet record: Owner / Primary carer confirmed, Family proposed
  CONFIRM_RECORDS: ['OWNER', 'PRIMARY_CARER'], // a Family member's edit becomes a proposal instead
  MANAGE_CARE: ['OWNER', 'PRIMARY_CARER'], // medication, routines, feeding plan
  SEE_COSTS: ['OWNER', 'PRIMARY_CARER'], // Family sees totals only (SEE_COST_TOTALS)
  SEE_COST_TOTALS: ['OWNER', 'PRIMARY_CARER', 'FAMILY'],
  SEE_DOCUMENTS: ['OWNER', 'PRIMARY_CARER', 'FAMILY'],
  VET_PACK: ['OWNER', 'PRIMARY_CARER', 'FAMILY'],
  EDIT_PROFILE: ['OWNER', 'PRIMARY_CARER'],
  MANAGE_ROLES: ['OWNER'], // change roles, mark rehomed / deceased
} as const satisfies Record<string, readonly Role[]>;
export type Action = keyof typeof ACTIONS;

export const can = (role: Role, action: Action): boolean => (ACTIONS[action] as readonly Role[]).includes(role);
export const effectiveRole = (explicit: Role | null | undefined): Role => explicit ?? DEFAULT_ROLE;
/** What a member may do on one animal, for the UI (the engine still checks every route). */
export const allowedActions = (role: Role): Action[] => (Object.keys(ACTIONS) as Action[]).filter((a) => can(role, a));

export interface RoleRow { member_name: string; role: Role }

/**
 * Pure last-Owner rule: would setting `member` to `next` (null = removing their role) leave the animal with no Owner?
 * Removing a role makes the member FAMILY by default, which is not an Owner.
 */
export function leavesNoOwner(current: RoleRow[], member: string, next: Role | null): boolean {
  const after = current.filter((r) => r.member_name !== member).map((r) => r.role);
  if (next) after.push(next);
  const hadOwner = current.some((r) => r.role === 'OWNER');
  return hadOwner && !after.includes('OWNER');
}

// ---------------- household (layer 1) ----------------

const ACTIVE = 'revoked_at IS NULL';

/** The household this member may open, or null (deny). One household today; the oldest grant wins if ever more. */
export async function householdOf(c: Client, member: string): Promise<number | null> {
  const r = await c.query<{ workspace_id: string }>(
    `SELECT workspace_id::text FROM core.access_grant WHERE member_name = $1 AND ${ACTIVE} ORDER BY workspace_id LIMIT 1`,
    [member],
  );
  return r.rows[0] ? Number(r.rows[0].workspace_id) : null;
}

export const adminsFromEnv = (v = process.env.PETOPIA_ADMINS ?? ''): string[] =>
  v.split(',').map((s) => s.trim()).filter(Boolean);

/**
 * First-sign-in bootstrap (Vitalis's VITALIS_ADMINS pattern): a member named in PETOPIA_ADMINS is granted the household
 * (workspace 1) if they have never had a grant. A revoked grant is NOT renewed -- a revocation stands.
 */
export async function ensureAdminGrant(c: Client, member: string, admins = adminsFromEnv()): Promise<void> {
  if (!admins.includes(member)) return;
  await c.query(
    `INSERT INTO core.access_grant (workspace_id, member_name, granted_by) VALUES (1, $1, 'PETOPIA_ADMINS')
     ON CONFLICT (workspace_id, member_name) DO NOTHING`,
    [member],
  );
}

export async function requireHousehold(c: Client, member: string): Promise<number> {
  const ws = await householdOf(c, member);
  if (ws === null) throw forbidden('you have no Petopia access in this household yet');
  return ws;
}

/** Granting household access: only someone who already has it (and is an admin) may. */
export async function grantHousehold(c: Client, ws: number, member: string, actor: string, admins = adminsFromEnv()): Promise<void> {
  const m = member.trim();
  if (!m) throw bad('member is required');
  if ((await householdOf(c, actor)) !== ws || !admins.includes(actor)) throw forbidden('only a household admin can give access');
  await c.query(
    `INSERT INTO core.access_grant (workspace_id, member_name, granted_by) VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, member_name) DO UPDATE SET granted_by = EXCLUDED.granted_by, granted_at = now(), revoked_at = NULL, revoked_by = NULL`,
    [ws, m, actor],
  );
}

// ---------------- per animal (layer 2) ----------------

async function animalExists(c: Client, animalId: number): Promise<boolean> {
  return ((await c.query('SELECT 1 FROM animal.animal WHERE animal_id = $1', [animalId])).rowCount ?? 0) > 0;
}

/** The member's current role on an animal; FAMILY when they have none. 404 if the animal is not in this household. */
export async function roleOn(c: Client, animalId: number, member: string): Promise<Role> {
  if (!(await animalExists(c, animalId))) throw notFound('no such animal');
  const r = await c.query<{ role: Role }>('SELECT role FROM core.animal_role WHERE animal_id = $1 AND member_name = $2 AND to_on IS NULL', [animalId, member]);
  return effectiveRole(r.rows[0]?.role);
}

export async function requireOn(c: Client, animalId: number, member: string, action: Action): Promise<Role> {
  const role = await roleOn(c, animalId, member);
  if (!can(role, action)) throw forbidden(`a ${role.toLowerCase().replace('_', ' ')} cannot do that for this animal`);
  return role;
}

/** Locks and returns the animal's current role rows, so two concurrent changes cannot both pass the last-Owner rule. */
async function lockedRoles(c: Client, animalId: number): Promise<RoleRow[]> {
  return (await c.query<RoleRow>('SELECT member_name, role FROM core.animal_role WHERE animal_id = $1 AND to_on IS NULL FOR UPDATE', [animalId])).rows;
}

async function writeRole(c: Client, ws: number, animalId: number, member: string, role: Role | null, actor: string): Promise<void> {
  await c.query('UPDATE core.animal_role SET to_on = current_date WHERE animal_id = $1 AND member_name = $2 AND to_on IS NULL', [animalId, member]);
  if (role) {
    await c.query('INSERT INTO core.animal_role (workspace_id, animal_id, member_name, role, set_by) VALUES ($1, $2, $3, $4, $5)', [ws, animalId, member, role, actor]);
  }
}

/** Used only inside the transaction that creates the animal: its creator is its first Owner. */
export async function setFirstOwner(c: Client, ws: number, animalId: number, member: string): Promise<void> {
  await writeRole(c, ws, animalId, member, 'OWNER', member);
}

/** Owner only. The target must have household access. Refused if it would leave the animal with no Owner. */
export async function setAnimalRole(c: Client, ws: number, animalId: number, member: string, role: Role, actor: string): Promise<void> {
  if (!isRole(role)) throw bad(`role must be one of ${ROLES.join(', ')}`);
  await requireOn(c, animalId, actor, 'MANAGE_ROLES');
  if ((await householdOf(c, member)) !== ws) throw bad('that person has no Petopia access in this household');
  if (leavesNoOwner(await lockedRoles(c, animalId), member, role)) throw conflict('every animal needs at least one Owner; add another Owner first');
  await writeRole(c, ws, animalId, member, role, actor);
}

/** An Owner may remove anyone's role; anyone may remove their own. Never the last Owner. */
export async function endAnimalRole(c: Client, ws: number, animalId: number, member: string, actor: string): Promise<void> {
  if (actor !== member) await requireOn(c, animalId, actor, 'MANAGE_ROLES');
  else await roleOn(c, animalId, actor);
  if (leavesNoOwner(await lockedRoles(c, animalId), member, null)) throw conflict('the last Owner cannot leave; make someone else an Owner first');
  await writeRole(c, ws, animalId, member, null, actor);
}
