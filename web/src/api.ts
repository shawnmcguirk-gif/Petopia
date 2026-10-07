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
  latest_weight: { kg: string; on: string } | null;
  photo: string | null;
  my_role: 'OWNER' | 'PRIMARY_CARER' | 'FAMILY' | 'VIEWER';
  can: string[];
}
export interface Me { member: string; household: { id: number } | null }
export type NewAnimal = { name: string; species: string; breed?: string; born?: string; sex?: string; neuter_status?: string; colour_markings?: string; microchip?: string };
