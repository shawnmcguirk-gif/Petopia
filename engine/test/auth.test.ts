// auth.ts fails closed (spec sec 2 "Identity", A5) and PETOPIA_AUTH=off is refused in production.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertAuthConfig, authorise, clearAuthCache } from '../src/auth.js';

const ENV = { ...process.env };
const reply = (status: number, body: unknown) => vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));

beforeEach(() => clearAuthCache());
afterEach(() => {
  process.env = { ...ENV };
  vi.unstubAllGlobals();
});

describe('authorise', () => {
  it('no token -> 401, without calling the verifier', async () => {
    const f = reply(200, { ok: true, member_name: 'Alex' });
    vi.stubGlobal('fetch', f);
    expect(await authorise(undefined)).toEqual({ ok: false, status: 401, reason: 'missing device token' });
    expect(f).not.toHaveBeenCalled();
  });
  it('verifier unreachable -> 401, not cached', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))));
    expect(await authorise('tok-a')).toMatchObject({ ok: false, status: 401, reason: 'verifier unreachable' });
    vi.stubGlobal('fetch', reply(200, { ok: true, member_name: 'Alex' }));
    expect(await authorise('tok-a')).toEqual({ ok: true, member: 'Alex' });
  });
  it('unapproved device, non-200, or no member_name -> 401 "device not approved"', async () => {
    for (const [s, b] of [[200, { ok: false }], [403, { ok: true, member_name: 'Alex' }], [200, { ok: true, member_name: '  ' }], [200, { ok: true }]] as const) {
      clearAuthCache();
      vi.stubGlobal('fetch', reply(s, b));
      expect(await authorise('tok-b')).toEqual({ ok: false, status: 401, reason: 'device not approved' });
    }
  });
  it('a garbage reply -> 401', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('<html>', { status: 200 }))));
    expect(await authorise('tok-c')).toMatchObject({ ok: false, status: 401 });
  });
  it('approved -> the member; approvals are cached, refusals are not', async () => {
    const f = reply(200, { ok: true, member_name: ' Alex ' });
    vi.stubGlobal('fetch', f);
    expect(await authorise('tok-d')).toEqual({ ok: true, member: 'Alex' });
    expect(await authorise('tok-d')).toEqual({ ok: true, member: 'Alex' });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('feature gate: only when PETOPIA_REQUIRE_FEATURE=on, a reply without petopia is 403', async () => {
    vi.stubGlobal('fetch', reply(200, { ok: true, member_name: 'Alex', allowed_features: ['vitalis'] }));
    expect(await authorise('tok-e')).toEqual({ ok: true, member: 'Alex' });
    clearAuthCache();
    process.env.PETOPIA_REQUIRE_FEATURE = 'on';
    expect(await authorise('tok-e')).toEqual({ ok: false, status: 403, reason: 'feature not granted' });
    vi.stubGlobal('fetch', reply(200, { ok: true, member_name: 'Alex' }));
    expect(await authorise('tok-e')).toMatchObject({ ok: false, status: 403 });
    vi.stubGlobal('fetch', reply(200, { ok: true, member_name: 'Alex', allowed_features: ['petopia'] }));
    expect(await authorise('tok-e')).toEqual({ ok: true, member: 'Alex' });
  });
});

describe('PETOPIA_AUTH=off', () => {
  it('works in development with a dev member, and needs one', async () => {
    process.env.PETOPIA_AUTH = 'off';
    delete process.env.NODE_ENV;
    delete process.env.PETOPIA_DEV_MEMBER;
    expect(await authorise(undefined)).toMatchObject({ ok: false, status: 401 });
    process.env.PETOPIA_DEV_MEMBER = 'Tester';
    expect(await authorise(undefined)).toEqual({ ok: true, member: 'Tester' });
    expect(await authorise(undefined, 'Other')).toEqual({ ok: true, member: 'Other' });
    expect(() => assertAuthConfig()).not.toThrow();
  });
  it('is refused in production: at start-up and on every request', async () => {
    process.env.PETOPIA_AUTH = 'off';
    process.env.NODE_ENV = 'production';
    process.env.PETOPIA_DEV_MEMBER = 'Tester';
    expect(() => assertAuthConfig()).toThrow(/PETOPIA_AUTH=off/);
    expect(await authorise('anything', 'Tester')).toMatchObject({ ok: false, status: 401 });
  });
});
