// Animals (spec sec 3.3, 9.3, 9.4; A6). Every function runs inside a transaction that has already chosen the household
// (FORCE RLS), and checks the caller's role on the animal first (access.ts). Age is computed, never stored.
import { sql } from 'kysely';
import { requireOn, roleOn, setFirstOwner, allowedActions, type Role, type Action } from './access.js';
import { ageOf, formatVagueDate, parseVagueDate, todayIso, type Age, type Precision } from './age.js';
import { kdb, type Client } from './db.js';
import { bad, notFound } from './errors.js';
import { assertExt, type SpeciesModule } from './species.js';
import { currentFoods, type FoodSummary } from './feeding.js';
import { latestWeights, type LatestWeight } from './measurements.js';
import { currentByAnimal, type CurrentMedicine } from './medications.js';
import { checkContact } from './records.js';
import { processPhoto, storePhoto, type Processed } from './photos.js';

const SEX = ['FEMALE', 'MALE', 'UNKNOWN'] as const;
const NEUTER = ['NEUTERED', 'ENTIRE', 'UNKNOWN'] as const;
const STATUS = ['ACTIVE', 'REHOMED', 'DECEASED'] as const;
const KIND = ['PET', 'CARED_FOR'] as const;
const HEALTH = ['HEALTHY', 'UNDER_TREATMENT', 'NEEDS_ATTENTION'] as const;

export interface AnimalView {
  id: number;
  name: string;
  nickname: string | null;
  species: string;
  module: string;
  breed: string | null;
  sex: string;
  neuter_status: string;
  colour_markings: string | null;
  born: string | null; // as typed: "2018", "2018-03", "2018-03-14"
  born_precision: Precision;
  age: Age | null;
  acquired: string | null;
  acquired_precision: Precision;
  microchip: string | null;
  registration: string | null;
  source: string | null;
  habitat: string | null;
  kind: string;
  status: string;
  status_on: string | null;
  /** Set by a person (Owner / Primary carer); null until someone does. Never computed (sec 9.3). */
  health_status: string | null;
  /** The latest CONFIRMED weight (S3) with its change since the one before; null until one is recorded (UI hides it). */
  latest_weight: LatestWeight | null;
  /** The current food (S3), or null. */
  current_food: FoodSummary | null;
  /** Derived from confirmed medication events (S4); stopped medicines are not here. */
  current_medication: Pick<CurrentMedicine, 'medication_id' | 'product_name' | 'dose' | 'frequency' | 'since'>[];
  /** The usual vet practice and the emergency contact (core.contact), when set. */
  vet: { id: number; name: string; phone: string | null } | null;
  emergency_contact: { id: number; name: string; phone: string | null } | null;
  photo: string | null; // "api/media/<sha>.jpg", relative to the app's base
  ext: Record<string, unknown>;
  my_role: Role;
  can: Action[];
}

const one = <T,>(v: T | undefined, what: string): T => {
  if (v === undefined) throw notFound(what);
  return v;
};
const str = (v: unknown, field: string, max = 200): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw bad(`${field} must be text`);
  const t = v.trim();
  if (t.length > max) throw bad(`${field} is too long`);
  return t || null;
};
const pick = <T extends string>(v: unknown, allowed: readonly T[], field: string): T => {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw bad(`${field} must be one of ${allowed.join(', ')}`);
  return v as T;
};
/** A microchip number: spaces removed, then 6-23 letters or digits (the DB CHECK is the second line). */
export function cleanMicrochip(v: unknown): string | null {
  const m = str(v, 'microchip', 40);
  if (!m) return null;
  const chip = m.replace(/\s+/g, '');
  if (!/^[0-9A-Za-z]{6,23}$/.test(chip)) throw bad('a microchip number is 6 to 23 letters or digits');
  return chip;
}

const vague = (v: unknown, field: string): { on: string | null; precision: Precision } => {
  if (v === undefined || v === null || v === '') return { on: null, precision: 'UNKNOWN' };
  const p = parseVagueDate(v);
  if (!p) throw bad(`${field} must be a year (2018), a month (2018-03) or a date (2018-03-14)`);
  if (p.on > todayIso()) throw bad(`${field} cannot be in the future`);
  return p;
};

type Resolved = SpeciesModule & { species_id: number; common_name: string };

/** The module itself, by code. Used when an existing animal's `ext` is edited (the species is already fixed). */
async function loadModule(c: Client, code: string): Promise<SpeciesModule> {
  const r = await kdb(c).selectFrom('ref.species_module').select(['code', 'schema', 'schema_version']).where('code', '=', code).executeTakeFirst();
  if (!r) throw bad(`Petopia does not have a ${code} module yet`);
  return { code: r.code, schema: r.schema, schema_version: r.schema_version };
}

/**
 * Which species (and so which module) a new animal is. `species` is the species' id, its name ("Rabbit", case
 * does not matter), or -- from before any-animal support -- the old module code "dog" / "cat". Only species that
 * have a module are offered, so an unknown or module-less species is refused rather than guessed.
 */
async function resolveSpecies(c: Client, input: unknown): Promise<Resolved> {
  if (typeof input !== 'string' && typeof input !== 'number') throw bad('species is required');
  const q = kdb(c)
    .selectFrom('ref.species as s')
    .innerJoin('ref.species_module as m', 'm.code', 's.module_code')
    .select(['m.code', 'm.schema', 'm.schema_version', 's.species_id', 's.common_name'])
    .where('s.domain', 'in', ['PET', 'BOTH']);
  let r;
  const asId = typeof input === 'number' ? input : /^\d+$/.test(input.trim()) ? Number(input.trim()) : null;
  if (asId !== null) {
    if (!Number.isSafeInteger(asId) || asId < 1) throw bad('species must be a species id or a name');
    r = await q.where('s.species_id', '=', String(asId)).executeTakeFirst();
  } else {
    const t = (input as string).trim().toLowerCase(); // 'dog' and 'cat', the old spellings, are species names too
    if (!t) throw bad('species is required');
    r = await q.where(sql`lower(s.common_name)`, '=', t).executeTakeFirst();
  }
  if (!r) throw bad('Petopia does not know that kind of animal -- pick "Other animal" and type what it is');
  return { code: r.code, schema: r.schema, schema_version: r.schema_version, species_id: Number(r.species_id), common_name: r.common_name };
}

/** What the "Add animal" picker offers: every pet species that has a module, in a stable, grouped order. */
export async function listSpecies(c: Client): Promise<{ id: number; name: string; group: string; module: string }[]> {
  const rows = await kdb(c)
    .selectFrom('ref.species as s')
    .select(['s.species_id', 's.common_name', 's.group', 's.module_code'])
    .where('s.domain', 'in', ['PET', 'BOTH'])
    .where('s.module_code', 'is not', null)
    .execute();
  const order = ['DOG', 'CAT', 'MAMMAL', 'BIRD', 'REPTILE', 'AMPHIBIAN', 'FISH', 'INSECT', 'OTHER'];
  return rows
    .map((r) => ({ id: Number(r.species_id), name: r.common_name, group: r.group, module: r.module_code! }))
    .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || (a.group === 'OTHER' ? 0 : a.name.localeCompare(b.name)));
}

/** The generic "Other animal" species carries the person's own words for what it is. */
export const OTHER_SPECIES = 'Other animal';

/**
 * The rule for `species_name`: "Other animal" must say what it is (on creation and on every later edit of its details),
 * and no other species may carry one -- it would sit unseen while still steering document matching.
 */
function checkKind(speciesName: string, ext: Record<string, unknown>): Record<string, unknown> {
  if (speciesName !== OTHER_SPECIES) {
    if ('species_name' in ext) throw bad('species_name is only for "Other animal"');
    return ext;
  }
  const kind = typeof ext.species_name === 'string' ? ext.species_name.trim() : '';
  if (!kind) throw bad('say what kind of animal it is (for example "Tarantula")');
  return { ...ext, species_name: kind };
}

function baseQuery(c: Client) {
  return kdb(c)
    .selectFrom('animal.animal as a')
    .innerJoin('ref.species as s', 's.species_id', 'a.species_id')
    .leftJoin('core.habitat as h', 'h.habitat_id', 'a.habitat_id')
    .leftJoin('media.item as p', (j) => j.onRef('p.media_item_id', '=', 'a.profile_media_id').on('p.retired_at', 'is', null))
    .leftJoin('core.contact as v', 'v.contact_id', 'a.vet_contact_id')
    .leftJoin('core.contact as e', 'e.contact_id', 'a.emergency_contact_id')
    .select([
      'a.animal_id', 'a.name', 'a.nickname', 's.common_name as species', 'a.module_code', 'a.breed', 'a.sex', 'a.neuter_status', 'a.colour_markings',
      'a.born_on', 'a.born_precision', 'a.acquired_on', 'a.acquired_precision', 'a.microchip', 'a.registration', 'a.source', 'h.name as habitat',
      'a.kind', 'a.status', 'a.status_on', 'a.health_status', 'a.ext', 'p.sha256',
      'v.contact_id as vet_id', 'v.name as vet_name', 'v.phone as vet_phone', 'e.contact_id as em_id', 'e.name as em_name', 'e.phone as em_phone',
    ]);
}
type Row = Awaited<ReturnType<ReturnType<typeof baseQuery>['executeTakeFirstOrThrow']>>;

interface Extras { weights: Map<number, LatestWeight>; foods: Map<number, FoodSummary>; meds: Map<number, CurrentMedicine[]> }
async function extras(c: Client): Promise<Extras> {
  return { weights: await latestWeights(c), foods: await currentFoods(c), meds: await currentByAnimal(c) };
}

/** "Other animal" shows what the person typed ("Tarantula"); every other species shows its own name. */
function speciesLabel(r: Row): string {
  const n = r.species === OTHER_SPECIES ? (r.ext as { species_name?: unknown } | null)?.species_name : null;
  return typeof n === 'string' && n.trim() ? n.trim() : r.species;
}

function view(r: Row, role: Role, today: string, x: Extras): AnimalView {
  const id = Number(r.animal_id);
  const bp = r.born_precision as Precision;
  const ap = r.acquired_precision as Precision;
  return {
    id, name: r.name, nickname: r.nickname, species: speciesLabel(r), module: r.module_code, breed: r.breed,
    sex: r.sex, neuter_status: r.neuter_status, colour_markings: r.colour_markings,
    born: formatVagueDate(r.born_on, bp), born_precision: bp, age: ageOf(r.born_on, bp, today),
    acquired: formatVagueDate(r.acquired_on, ap), acquired_precision: ap,
    microchip: r.microchip, registration: r.registration, source: r.source, habitat: r.habitat ?? null,
    kind: r.kind, status: r.status, status_on: r.status_on, health_status: r.health_status,
    latest_weight: x.weights.get(id) ?? null, current_food: x.foods.get(id) ?? null,
    current_medication: (x.meds.get(id) ?? []).map((m) => ({ medication_id: m.medication_id, product_name: m.product_name, dose: m.dose, frequency: m.frequency, since: m.since })),
    vet: r.vet_id ? { id: Number(r.vet_id), name: r.vet_name!, phone: r.vet_phone ?? null } : null,
    emergency_contact: r.em_id ? { id: Number(r.em_id), name: r.em_name!, phone: r.em_phone ?? null } : null,
    photo: r.sha256 ? `api/media/${r.sha256}.jpg` : null, ext: r.ext ?? {},
    my_role: role, can: allowedActions(role),
  };
}

async function rolesFor(c: Client, member: string): Promise<Map<number, Role>> {
  const r = await kdb(c).selectFrom('core.animal_role').select(['animal_id', 'role']).where('member_name', '=', member).where('to_on', 'is', null).execute();
  return new Map(r.map((x) => [Number(x.animal_id), x.role as Role]));
}

/** Everyone with household access sees every animal (sec 7.2 row 1); active animals first, then by name. */
export async function listAnimals(c: Client, member: string, today = todayIso()): Promise<AnimalView[]> {
  const roles = await rolesFor(c, member);
  const rows = await baseQuery(c)
    .orderBy(sql`a.status = 'ACTIVE'`, 'desc')
    .orderBy(sql`lower(a.name)`)
    .execute();
  const x = await extras(c);
  return rows.map((r) => view(r, roles.get(Number(r.animal_id)) ?? 'FAMILY', today, x));
}

export async function getAnimal(c: Client, id: number, member: string, today = todayIso()): Promise<AnimalView> {
  const role = await requireOn(c, id, member, 'VIEW');
  return view(one(await baseQuery(c).where('a.animal_id', '=', String(id)).executeTakeFirst(), 'no such animal'), role, today, await extras(c));
}

export interface NewAnimal {
  name?: unknown; species?: unknown; breed?: unknown; sex?: unknown; neuter_status?: unknown; born?: unknown; acquired?: unknown;
  nickname?: unknown; colour_markings?: unknown; microchip?: unknown; kind?: unknown; ext?: unknown;
}

/** Add an animal (sec 9.4 step 1). The creator becomes its first Owner, in the same transaction. Lives at Home. */
export async function createAnimal(c: Client, ws: number, member: string, b: NewAnimal, today = todayIso()): Promise<AnimalView> {
  const name = str(b.name, 'name', 80);
  if (!name) throw bad('name is required');
  let mod = await resolveSpecies(c, b.species);
  let given = b.ext ?? {};
  if (mod.common_name === OTHER_SPECIES) {
    // Someone who types a kind we already know ("Rabbit") gets that species, with its own fields, routines and limits.
    const typed = (given as { species_name?: unknown }).species_name;
    if (typeof typed === 'string' && typed.trim()) {
      const known = await resolveSpecies(c, typed).catch(() => null);
      if (known && known.common_name !== OTHER_SPECIES) { mod = known; given = {}; }
    }
  }
  const ext = checkKind(mod.common_name, assertExt(mod, given));
  const born = vague(b.born, 'born');
  const acquired = vague(b.acquired, 'acquired');
  const home = await kdb(c).selectFrom('core.habitat').select('habitat_id').where('kind', '=', 'HOME').where('retired_at', 'is', null).orderBy('habitat_id').executeTakeFirst();
  const microchip = cleanMicrochip(b.microchip);
  const ins = await kdb(c)
    .insertInto('animal.animal')
    .values({
      workspace_id: ws, name, nickname: str(b.nickname, 'nickname', 80), species_id: mod.species_id, breed: str(b.breed, 'breed', 80),
      module_code: mod.code, ext: JSON.stringify(ext), ext_schema_version: mod.schema_version,
      sex: b.sex === undefined ? 'UNKNOWN' : pick(b.sex, SEX, 'sex'),
      neuter_status: b.neuter_status === undefined ? 'UNKNOWN' : pick(b.neuter_status, NEUTER, 'neuter_status'),
      colour_markings: str(b.colour_markings, 'colour_markings'),
      born_on: born.on, born_precision: born.precision, acquired_on: acquired.on, acquired_precision: acquired.precision,
      microchip,
      kind: b.kind === undefined ? 'PET' : pick(b.kind, KIND, 'kind'),
      habitat_id: home ? Number(home.habitat_id) : null,
      created_by: member,
    })
    .returning('animal_id')
    .executeTakeFirstOrThrow();
  const id = Number(ins.animal_id);
  await setFirstOwner(c, ws, id, member);
  return getAnimal(c, id, member, today);
}

/** Basic profile edits (Owner / Primary carer); status changes (rehomed / deceased) are Owner only (sec 7.2). */
export async function updateAnimal(c: Client, id: number, member: string, b: Record<string, unknown>, today = todayIso()): Promise<AnimalView> {
  await requireOn(c, id, member, 'EDIT_PROFILE');
  const cur = one(await kdb(c).selectFrom('animal.animal').select(['module_code', 'ext', 'status']).where('animal_id', '=', String(id)).executeTakeFirst(), 'no such animal');
  const set: Record<string, unknown> = {};
  const known = new Set(['name', 'nickname', 'breed', 'sex', 'neuter_status', 'colour_markings', 'born', 'acquired', 'microchip', 'registration', 'source', 'health_status', 'status', 'status_on', 'ext', 'vet_contact_id', 'emergency_contact_id']);
  for (const k of Object.keys(b)) if (!known.has(k)) throw bad(`${k} cannot be changed here`);
  if ('name' in b) { const n = str(b.name, 'name', 80); if (!n) throw bad('name cannot be empty'); set.name = n; }
  for (const k of ['nickname', 'breed', 'colour_markings', 'registration', 'source'] as const) if (k in b) set[k] = str(b[k], k);
  if ('microchip' in b) set.microchip = cleanMicrochip(b.microchip);
  for (const k of ['vet_contact_id', 'emergency_contact_id'] as const) {
    if (!(k in b)) continue;
    const v = b[k];
    if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 1)) throw bad(`${k} must be a contact id or null`);
    await checkContact(c, v);
    set[k] = v;
  }
  if ('sex' in b) set.sex = pick(b.sex, SEX, 'sex');
  if ('neuter_status' in b) set.neuter_status = pick(b.neuter_status, NEUTER, 'neuter_status');
  if ('born' in b) { const v = vague(b.born, 'born'); set.born_on = v.on; set.born_precision = v.precision; }
  if ('acquired' in b) { const v = vague(b.acquired, 'acquired'); set.acquired_on = v.on; set.acquired_precision = v.precision; }
  if ('health_status' in b) {
    set.health_status = b.health_status === null ? null : pick(b.health_status, HEALTH, 'health_status');
    set.health_status_by = set.health_status === null ? null : member;
    set.health_status_at = set.health_status === null ? null : new Date().toISOString();
  }
  if ('status' in b || 'status_on' in b) {
    await requireOn(c, id, member, 'MANAGE_ROLES');
    const st = 'status' in b ? pick(b.status, STATUS, 'status') : cur.status;
    set.status = st;
    set.status_on = st === 'ACTIVE' ? null : vague(b.status_on ?? today, 'status_on').on;
  }
  if ('ext' in b) {
    const mod = await loadModule(c, cur.module_code);
    const checked = assertExt(mod, b.ext);
    const sp = await kdb(c).selectFrom('animal.animal as a').innerJoin('ref.species as s', 's.species_id', 'a.species_id').select('s.common_name').where('a.animal_id', '=', String(id)).executeTakeFirstOrThrow();
    set.ext = JSON.stringify(checkKind(sp.common_name, checked));
    set.ext_schema_version = mod.schema_version;
  }
  if (Object.keys(set).length) {
    await kdb(c).updateTable('animal.animal').set({ ...set, updated_at: new Date().toISOString() }).where('animal_id', '=', String(id)).execute();
  }
  return getAnimal(c, id, member, today);
}

/** Decodes + re-encodes outside the transaction (CPU only); call setProfilePhoto with the result inside it. */
export const preparePhoto = (dataBase64: unknown): Promise<Processed> => {
  if (typeof dataBase64 !== 'string' || !dataBase64) throw bad('no photo was sent');
  return processPhoto(Buffer.from(dataBase64.replace(/^data:[^,]*,/, ''), 'base64'));
};

/** Profile photo (sec 9.4 step 2): Owner / Primary carer / Family may add photos (sec 7.2). */
export async function setProfilePhoto(c: Client, ws: number, id: number, member: string, p: Processed, root: string, today = todayIso()): Promise<AnimalView> {
  await requireOn(c, id, member, 'ADD_MEDIA');
  const path = await storePhoto(root, p); // a file written before a failed commit is harmless: named by its own hash
  const m = await c.query<{ media_item_id: string }>(
    `INSERT INTO media.item (workspace_id, sha256, path, width, height, added_by) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (workspace_id, sha256) DO UPDATE SET retired_at = NULL RETURNING media_item_id`,
    [ws, p.sha256, path, p.width, p.height, member],
  );
  await c.query('UPDATE animal.animal SET profile_media_id = $2, updated_at = now() WHERE animal_id = $1', [id, m.rows[0]!.media_item_id]);
  return getAnimal(c, id, member, today);
}

/** A media file may be read only if its hash is a live item of this household (RLS) -- the caller then reads the file. */
export async function mediaVisible(c: Client, sha: string): Promise<boolean> {
  return ((await c.query('SELECT 1 FROM media.item WHERE sha256 = $1 AND retired_at IS NULL', [sha])).rowCount ?? 0) > 0;
}

export { roleOn };
