// Identity (spec sec 2 "Identity" / "Feature gate", A5): Synapse's device token in X-Serenity-Device, verified by n8n's
// verify-device webhook, exactly as Vitalis/Epicure auth.ts. Any approved member may call; the household grant and the
// per-animal roles in access.ts decide what they may do. Fails CLOSED: no token, an unreachable verifier, an unapproved
// device or a reply without member_name all mean 401. Only approvals are cached (a minute), bounded.
//
// Feature gate (sec 11.2): until Synapse's feature vocabulary has 'petopia' (migration 059, Ryan's call, Q5) the engine
// admits any approved member, as Epicure did before D39. Setting PETOPIA_REQUIRE_FEATURE=on turns the check on: then a
// reply whose allowed_features lacks 'petopia' is 403 'feature not granted'.
//
// PETOPIA_AUTH=off is for local development only: it acts as PETOPIA_DEV_MEMBER (or the test header) and is REFUSED when
// NODE_ENV=production -- both here, per request, and at start-up (assertAuthConfig), and by install-launchagent.sh.
const VERIFY_URL = () => process.env.PETOPIA_AUTH_VERIFY_URL ?? 'http://localhost:5678/webhook/verify-device';
const TTL_MS = 60_000;
const MAX_CACHED = 500;
const cache = new Map<string, { at: number; verdict: Verdict }>();

/** persona: Synapse's persona_key for the member (Vitalis auth.ts), used to put vet appointments on their calendar (S6). */
export type Verdict = { ok: true; member: string; persona?: string } | { ok: false; status: 401 | 403; reason: string };

export const authOff = (): boolean => process.env.PETOPIA_AUTH === 'off';
export const isProduction = (): boolean => process.env.NODE_ENV === 'production';

/** Throws at start-up if auth is switched off in production. */
export function assertAuthConfig(): void {
  if (authOff() && isProduction()) throw new Error('refusing to start: PETOPIA_AUTH=off is not allowed when NODE_ENV=production');
}

export function clearAuthCache(): void {
  cache.clear();
}

export async function authorise(token: string | undefined, testMember?: string): Promise<Verdict> {
  if (authOff()) {
    if (isProduction()) return { ok: false, status: 401, reason: 'authentication cannot be switched off in production' };
    const m = (testMember ?? process.env.PETOPIA_DEV_MEMBER ?? '').trim();
    return m ? { ok: true, member: m } : { ok: false, status: 401, reason: 'PETOPIA_AUTH=off needs PETOPIA_DEV_MEMBER' };
  }
  if (!token) return { ok: false, status: 401, reason: 'missing device token' };
  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.verdict;
  let verdict: Verdict;
  try {
    const res = await fetch(VERIFY_URL(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_token: token }),
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json()) as { ok?: boolean; member_name?: unknown; persona_key?: unknown; allowed_features?: unknown };
    const name = typeof body.member_name === 'string' ? body.member_name.trim() : '';
    if (!res.ok || body.ok !== true || !name) verdict = { ok: false, status: 401, reason: 'device not approved' };
    else if (process.env.PETOPIA_REQUIRE_FEATURE === 'on' && (!Array.isArray(body.allowed_features) || !body.allowed_features.includes('petopia')))
      verdict = { ok: false, status: 403, reason: 'feature not granted' };
    else verdict = { ok: true, member: name, ...(typeof body.persona_key === 'string' && body.persona_key ? { persona: body.persona_key } : {}) };
  } catch {
    return { ok: false, status: 401, reason: 'verifier unreachable' }; // not cached: retry next request
  }
  // Only approvals are cached: a refusal is re-checked next time, so a newly approved device works at once.
  if (verdict.ok) {
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
    cache.set(token, { at: Date.now(), verdict });
  }
  return verdict;
}
