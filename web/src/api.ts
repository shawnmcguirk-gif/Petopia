// API calls are relative to the page (so they work at / and under /petopia/) and carry Synapse's device token: the app
// runs same-origin inside Synapse, so Synapse's own localStorage session is readable (as Vitalis/Epicure). The engine
// verifies the token and decides everything; the UI only shows what it is given.
const deviceToken = (): string | undefined => {
  try {
    return (JSON.parse(localStorage.getItem('serenity.device') ?? 'null') as { deviceToken?: string } | null)?.deviceToken;
  } catch {
    return undefined;
  }
};
const url = (u: string): string => u.replace(/^\//, '');
const headers = (extra: Record<string, string> = {}): Record<string, string> => {
  const t = deviceToken();
  return t ? { 'X-Serenity-Device': t, ...extra } : extra;
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
async function check<T>(r: Response): Promise<T> {
  if (!r.ok) throw new ApiError(r.status, ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `request failed (${r.status})`);
  return r.json() as Promise<T>;
}
export const get = async <T,>(u: string): Promise<T> => check<T>(await fetch(url(u), { headers: headers() }));
const send = async <T,>(method: string, u: string, body: unknown): Promise<T> =>
  check<T>(await fetch(url(u), { method, headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify(body) }));
export const post = <T,>(u: string, body: unknown = {}): Promise<T> => send<T>('POST', u, body);
export const patch = <T,>(u: string, body: unknown = {}): Promise<T> => send<T>('PATCH', u, body);

/** An <img> cannot carry the device header, so photos are fetched and shown from a blob URL (Vitalis's pattern). */
const blobs = new Map<string, Promise<string>>();
export function photoUrl(path: string): Promise<string> {
  let p = blobs.get(path);
  if (!p) {
    p = fetch(url(path), { headers: headers() }).then(async (r) => {
      if (!r.ok) throw new ApiError(r.status, 'photo unavailable');
      return URL.createObjectURL(await r.blob());
    });
    p.catch(() => blobs.delete(path));
    blobs.set(path, p);
  }
  return p;
}

// ---- shapes the engine returns (engine/src/animals.ts) ----
export interface Age { years: number; months: number; text: string; approximate: boolean }
export interface Animal {
  id: number;
  species_id: number;
  ext?: Record<string, unknown>;
  name: string;
  nickname: string | null;
  species: string;
  module: string;
  breed: string | null;
  sex: 'FEMALE' | 'MALE' | 'UNKNOWN';
  neuter_status: 'NEUTERED' | 'ENTIRE' | 'UNKNOWN';
  colour_markings: string | null;
  born: string | null;
  born_precision: 'DAY' | 'MONTH' | 'YEAR' | 'UNKNOWN';
  age: Age | null;
  acquired: string | null;
  microchip: string | null;
  habitat: string | null;
  kind: string;
  status: 'ACTIVE' | 'REHOMED' | 'DECEASED';
  health_status: 'HEALTHY' | 'UNDER_TREATMENT' | 'NEEDS_ATTENTION' | null;
  latest_weight: { kg: string; on: string; change_kg: string | null } | null;
  current_food: FoodSummary | null;
  current_medication: { medication_id: number; product_name: string; dose: string | null; frequency: string | null; since: string }[];
  vet: ContactRef | null;
  emergency_contact: ContactRef | null;
  photo: string | null;
  my_role: 'OWNER' | 'PRIMARY_CARER' | 'FAMILY' | 'VIEWER';
  can: string[];
}
export interface Me { member: string; household: { id: number } | null; admin?: boolean }
export interface SpeciesOption { id: number; name: string; group: string; module: string; has_about?: boolean }
export const OTHER_ANIMAL = 'Other animal';
export type NewAnimal = { name: string; species: string; ext?: Record<string, unknown>; breed?: string; born?: string; sex?: string; neuter_status?: string; colour_markings?: string; microchip?: string };

// ---- S3 / S4 shapes (engine/src/feeding.ts, measurements.ts, records.ts, medications.ts, timeline.ts) ----
export interface ContactRef { id: number; name: string; phone: string | null }
export interface Contact extends ContactRef { kind: string; email: string | null; address: string | null }
export interface Badge { code: 'VET_RECORD' | 'OUR_NOTE' | 'VET_ADVICE' | 'AI_SUGGESTION' | 'READ_FROM_DOCUMENT' | 'WAITING'; text: string }
export interface FoodSummary { brand: string | null; product: string | null; food_type: string; portion_amount: string | null; portion_unit: string | null; times: string[]; from_on: string }
export interface Feeding extends FoodSummary { id: number; to_on: string | null; objective: string | null; notes: string | null; badge: Badge; by: string }
export interface FeedingState { current: Feeding | null; history: Feeding[] }
export interface Measurement { id: number; measure: string; value: string; unit: string; value_as_entered: string; unit_as_entered: string; on: string; change: string | null; unusual_confirmed: boolean; by: string; note: string | null }
export interface RecordRow { id: number; kind: string; status: string; badge: Badge; by: string; confirmed_by: string | null; supersedes_id: number | null; created_at: string; fields: Record<string, string | number | null> }
export interface MedEvent { id: number; medication_id: number; event_kind: 'PRESCRIBED' | 'STARTED' | 'DOSE_CHANGED' | 'STOPPED'; event_on: string; dose_text: string | null; dose_amount: string | null; dose_unit: string | null; frequency: string | null; reason: string | null; badge: Badge }
export interface CurrentMedicine { medication_id: number; product_name: string; strength: string | null; dose: string | null; frequency: string | null; instructions: string | null; since: string; last_event_on: string }
export interface Medicine { id: number; product_name: string; strength: string | null; form: string | null; current: boolean; events: MedEvent[] }
export interface Medications { current: CurrentMedicine[]; medicines: Medicine[] }
export interface Health { records: Record<string, RecordRow[]>; medications: Medications; measurements: Measurement[] }
export interface TimelineEntry { on: string; sort_on: string; year: string; category: string; kind: string; label: string; title: string; detail: string | null; badge: Badge; ref: { table: string; id: number }; source?: { document_id: number; page: number | null } | null }

/** The engine's 409 for an unusual reading: nothing was saved; the person is asked. */
export class QuestionError extends ApiError {
  constructor(message: string, public suggestion: { value: string; unit: string } | null) {
    super(409, message);
  }
}
/** POST that turns the plausibility 409 into a QuestionError (so the form can ask instead of failing). */
export async function postAsking<T>(u: string, body: unknown): Promise<T> {
  const r = await fetch(url(u), { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify(body) });
  if (r.status === 409) {
    const j = (await r.json().catch(() => ({}))) as { error?: string; needs_confirmation?: boolean; suggestion?: { value: string; unit: string } | null };
    if (j.needs_confirmation) throw new QuestionError(j.error ?? 'Is that right?', j.suggestion ?? null);
    throw new ApiError(409, j.error ?? 'request failed (409)');
  }
  return check<T>(r);
}

/** The original of a filed document, opened from a blob URL (an <a> cannot carry the device header). */
export async function openDocument(documentId: number): Promise<void> {
  const r = await fetch(url(`api/documents/${documentId}/file`), { headers: headers() });
  if (!r.ok) throw new ApiError(r.status, ((await r.json().catch(() => ({}))) as { error?: string }).error ?? 'the original could not be opened');
  window.open(URL.createObjectURL(await r.blob()), '_blank', 'noopener');
}

// ---- S5 inbox (engine/src/inbox.ts) ----
export interface MyInbox { folder: string | null; suggested_folder: string; inbox_path: string | null; reading: boolean; ai_reading: boolean; folder_words: string; ai_words: string; local_reader: boolean }
export interface InboxRow { id: number; file_name: string; status: string; flags: string[]; member_name: string; animal_id: number | null; animal_proposed_id: number | null; doc_kind: string | null; doc_kind_proposed: string | null; document_date: string | null; dropped_count: number; proposals: number; discovered_at: string; filed_at: string | null }
export interface InboxList { waiting: InboxRow[]; recent: InboxRow[] }
export interface Proposal { id: number; target: string; payload: Record<string, string | number | null>; corrected: Record<string, string | number | null> | null; page: number; quote: string; flags: string[]; status: 'PROPOSED' | 'ACCEPTED' | 'CORRECTED' | 'DISMISSED'; decided_by: string | null; created_table: string | null; created_row_id: number | null }
export interface InboxItem extends Omit<InboxRow, 'proposals'> {
  document_id: number; found: { animal?: { name: string | null; species: string | null; microchip: string | null; page: number; quote: string }; document_date?: { value: string; page: number; quote: string }; provider?: { name: string; phone: string | null; page: number; quote: string }; costs?: { currency: string; total: string | null; lines: { description: string | null; amount: string; page: number; quote: string }[] } };
  document_date_assumed: boolean; decided_by: string | null; filed_path: string | null; pages: { page: number; text: string }[]; read_by: string | null;
  proposals: Proposal[]; runs: { method: string; status: string; model: string | null; dropped: number; at: string }[]; my_role: string | null; can_confirm: boolean;
}

// ---- S6 care (engine/src/care.ts) ----
export interface AgendaItem { key: string; animal_id: number; animal: string; kind: string; title: string; due_on: string; time: string | null; overdue: boolean; days: number; detail: string | null; routine_id: number | null; can_log: boolean }
export interface Today { today: AgendaItem[]; coming_up: AgendaItem[]; inbox_waiting?: number }
export interface Routine { id: number; animal_id: number; kind: string; title: string; rrule: string; times: string[]; medication_id: number | null; doses_per_time: string | null; assigned_to: string | null; remind: string; origin: string; source: { table: string; id: number } | null; active_from: string; active_to: string | null; next_due: string | null }
export interface Appointment { id: number; animal_id: number; starts_on: string; starts_time: string | null; contact_id: number | null; contact: string | null; reason: string | null; state: 'BOOKED' | 'CANCELLED'; calendar_state: 'SAVED' | 'ON_GOOGLE' | 'FAILED' | null; calendar_event_id: number | null; calendar_persona: string | null }
export interface CareView {
  routines: Routine[]; suggestions: { kind: string; title: string; rrule: string; times: string[] }[];
  log: { id: number; kind: string; routine_id: number | null; due_on: string | null; due_slot: string; done_at: string; done_by: string; note: string | null }[];
  appointments: Appointment[]; today: AgendaItem[]; coming_up: AgendaItem[];
  supplies: { medication_id: number; product_name: string; quantity: number; given: number; days_left: number | null }[];
}
export interface LogResult { logged: boolean; by: string; at: string }

// ---- S7 household (engine/src/household.ts) ----
export type Role = Animal['my_role'];
export interface Household {
  me: { member: string; admin: boolean; manages: boolean };
  members: { member_name: string; display_name: string | null; is_child: boolean; granted_at: string; granted_by: string; admin: boolean }[];
  animals: { id: number; name: string; status: string; roles: { member_name: string; role: Role; explicit: boolean }[] }[];
  habitats: { id: number; name: string; kind: string; parent_id: number | null }[];
  contacts: Contact[];
}

// ---- D2 About pages (engine/src/about.ts) ----
export interface AboutSource { title: string; publisher: string; url: string; checked_on: string }
export interface AboutStatement { text: string; withheld: boolean }
export type SpeciesAbout =
  | { state: 'NONE' }
  | {
      state: 'PAGE';
      species: { id: number; common_name: string; scientific_name: string | null; domain: string };
      version: number; checked_on: string; written_by: string; reviewed_by: string | null; source_count: number;
      headings: Record<string, string>;
      sections: Record<string, { statements: AboutStatement[]; sources: AboutSource[] }>;
    };
export interface AboutKind { tier: 'SPECIES' | 'NONE'; species?: { id: number; common_name: string; domain: string; has_page: boolean }; wild?: boolean; can_write: boolean }
