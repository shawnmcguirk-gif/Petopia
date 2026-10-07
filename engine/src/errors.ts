// One error type the HTTP layer maps straight to a status (Vitalis errors.ts, Petopia names).
export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 503;

export class PetopiaError extends Error {
  constructor(
    public readonly status: ErrorStatus,
    message: string,
    /** Extra fields sent beside `error` (e.g. the weight plausibility question and its suggestion). */
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const bad = (m: string) => new PetopiaError(400, m);
export const forbidden = (m: string) => new PetopiaError(403, m);
export const notFound = (m: string) => new PetopiaError(404, m);
export const conflict = (m: string, extra?: Record<string, unknown>) => new PetopiaError(409, m, extra);
export const invalid = (m: string) => new PetopiaError(422, m);

// Plain words for the named constraints a person can actually run into; everything else gets a generic sentence.
const CONSTRAINT_WORDS: Record<string, string> = {
  uq_animal_microchip: 'another animal in this household already has that microchip number',
  uq_feeding_plan_current: 'there is already a current food for this animal; change the food instead',
  animal_microchip_check: 'a microchip number is 6 to 23 letters or digits',
};

// Postgres error codes the engine turns into a 4xx rather than a 500: the database is the second line of the same
// rules the engine checks first (spec sec 4.2), so if one ever fires it is still the caller's mistake. The raw Postgres
// text is NEVER sent back (it names tables, columns and values -- independent review, 2026-10-07); a known constraint
// gets its own plain sentence, anything else a generic one.
export function fromPg(e: unknown): PetopiaError | null {
  const err = e as { code?: string; constraint?: string } | null;
  const code = err?.code;
  const known = err?.constraint ? CONSTRAINT_WORDS[err.constraint] : undefined;
  if (code === '23514') return conflict(known ?? 'that is not allowed by the record rules'); // check_violation (CHECKs + provenance/append-only guards)
  if (code === '23505') return conflict(known ?? 'that already exists in this household'); // unique_violation
  if (code === '23503') return bad('that refers to something that is not in this household'); // foreign_key_violation
  if (code === '23502') return bad('a required detail is missing'); // not_null_violation
  if (code === '42501') return forbidden('not allowed'); // insufficient_privilege / RLS
  if (code === '22P02' || code === '22007' || code === '22008' || code === '22003' || code === '22001') return bad('a value is not in the right format'); // bad input / date / range / too long
  return null;
}
