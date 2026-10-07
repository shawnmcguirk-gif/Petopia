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
export interface Me { member: string; household: { id: number } | null }
export type NewAnimal = { name: string; species: string; breed?: string; born?: string; sex?: string; neuter_status?: string; colour_markings?: string; microchip?: string };

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
export interface TimelineEntry { on: string; sort_on: string; year: string; category: string; kind: string; label: string; title: string; detail: string | null; badge: Badge; ref: { table: string; id: number } }

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
