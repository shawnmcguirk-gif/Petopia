// One error type the HTTP layer maps straight to a status (Vitalis errors.ts, Petopia names).
export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 503;

export class PetopiaError extends Error {
  constructor(
    public readonly status: ErrorStatus,
    message: string,
  ) {
    super(message);
  }
}

export const bad = (m: string) => new PetopiaError(400, m);
export const forbidden = (m: string) => new PetopiaError(403, m);
export const notFound = (m: string) => new PetopiaError(404, m);
export const conflict = (m: string) => new PetopiaError(409, m);
export const invalid = (m: string) => new PetopiaError(422, m);

// Postgres error codes the engine turns into a 4xx rather than a 500: the database is the second line of the same
// rules the engine checks first (spec sec 4.2), so if one ever fires it is still the caller's mistake.
export function fromPg(e: unknown): PetopiaError | null {
  const code = (e as { code?: string } | null)?.code;
  const msg = (e as { message?: string } | null)?.message ?? 'database refused';
  if (code === '23514') return conflict(msg); // check_violation (CHECKs and the provenance guard trigger)
  if (code === '23505') return conflict(msg); // unique_violation
  if (code === '23503') return bad(msg); // foreign_key_violation (reference not in this household)
  if (code === '42501') return forbidden(msg); // insufficient_privilege / RLS
  if (code === '22P02' || code === '22007' || code === '22008' || code === '22003') return bad(msg); // bad input syntax / date / range
  return null;
}
