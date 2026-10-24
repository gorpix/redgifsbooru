import { describe, expect, it } from 'vitest';
import { HttpError, type HttpRequest, type HttpResponse, type Transport } from '../src/api/http';
import { TokenManager, jwtExpiry } from '../src/api/token';

const toB64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64url = (obj: object) => toB64url(JSON.stringify(obj));
const jwt = (exp?: number) => `${b64url({ alg: 'none' })}.${b64url(exp === undefined ? {} : { exp })}.sig`;

function fakeTransport(script: HttpResponse[]) {
  const calls: HttpRequest[] = [];
  const transport: Transport = async (req) => {
    calls.push(req);
    return script[Math.min(calls.length - 1, script.length - 1)];
  };
  return { transport, calls };
}

const tokenResponse = (token: string): HttpResponse => ({ status: 200, text: JSON.stringify({ token }) });

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
  };
}

describe('jwtExpiry', () => {
  it('reads exp in ms from a base64url payload', () => {
    expect(jwtExpiry(jwt(2000))).toBe(2_000_000);
  });
  it('returns 0 when absent or unreadable', () => {
    expect(jwtExpiry(jwt())).toBe(0);
    expect(jwtExpiry('garbage')).toBe(0);
    expect(jwtExpiry('a.!!!.c')).toBe(0);
  });
  it('handles base64url characters', () => {
    const payload = toB64url(JSON.stringify({ exp: 5, pad: '??>>~~' }));
    expect(payload).toMatch(/[-_]/);
    expect(jwtExpiry(`h.${payload}.s`)).toBe(5000);
  });
});

describe('TokenManager', () => {
  it('fetches once from the auth endpoint and caches', async () => {
    const { transport, calls } = fakeTransport([tokenResponse('tok1')]);
    const tokens = new TokenManager(transport, null, () => 0);
    expect(await tokens.get()).toBe('tok1');
    expect(await tokens.get()).toBe('tok1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.redgifs.com/v2/auth/temporary');
  });

  it('shares one request between concurrent get() calls', async () => {
    const { transport, calls } = fakeTransport([tokenResponse('tok1')]);
    const tokens = new TokenManager(transport, null, () => 0);
    const all = await Promise.all([tokens.get(), tokens.get(), tokens.get()]);
    expect(all).toEqual(['tok1', 'tok1', 'tok1']);
    expect(calls).toHaveLength(1);
  });

  it('stores to storage and reloads from it', async () => {
    const storage = memoryStorage();
    const first = fakeTransport([tokenResponse('tok1')]);
    await new TokenManager(first.transport, storage, () => 0).get();
    expect(storage.data.size).toBe(1);

    const second = fakeTransport([tokenResponse('tok2')]);
    expect(await new TokenManager(second.transport, storage, () => 0).get()).toBe('tok1');
    expect(second.calls).toHaveLength(0);
  });

  it('ignores corrupt storage', async () => {
    const storage = memoryStorage({ 'rgb:guest-token': '{nope' });
    const { transport, calls } = fakeTransport([tokenResponse('tok1')]);
    expect(await new TokenManager(transport, storage, () => 0).get()).toBe('tok1');
    expect(calls).toHaveLength(1);
  });

  it('refresh=true fetches a new token', async () => {
    const { transport, calls } = fakeTransport([tokenResponse('tok1'), tokenResponse('tok2')]);
    const storage = memoryStorage();
    const tokens = new TokenManager(transport, storage, () => 0);
    expect(await tokens.get()).toBe('tok1');
    expect(await tokens.get(true)).toBe('tok2');
    expect(await tokens.get()).toBe('tok2');
    expect(calls).toHaveLength(2);
    expect(JSON.parse([...storage.data.values()][0]).token).toBe('tok2');
  });

  it('refetches an expired JWT, including inside the safety margin', async () => {
    let now = 1_000_000;
    const { transport, calls } = fakeTransport([tokenResponse(jwt(2000)), tokenResponse(jwt(9999))]);
    const tokens = new TokenManager(transport, null, () => now);
    const first = await tokens.get();
    expect(first).toBe(jwt(2000));
    now = 1_900_000; // still valid, outside the 60 s margin
    expect(await tokens.get()).toBe(first);
    expect(calls).toHaveLength(1);
    now = 1_950_000; // within 60 s of expiry
    expect(await tokens.get()).toBe(jwt(9999));
    expect(calls).toHaveLength(2);
  });

  it('refetches an expired token loaded from storage', async () => {
    const storage = memoryStorage({ 'rgb:guest-token': JSON.stringify({ token: 'old', expiresAt: 500 }) });
    const { transport, calls } = fakeTransport([tokenResponse('new')]);
    expect(await new TokenManager(transport, storage, () => 1000).get()).toBe('new');
    expect(calls).toHaveLength(1);
  });

  it('throws HttpError on non-200 and recovers afterwards', async () => {
    const { transport } = fakeTransport([{ status: 500, text: '' }, tokenResponse('ok')]);
    const tokens = new TokenManager(transport, null, () => 0);
    const err = await tokens.get().catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(500);
    expect(await tokens.get()).toBe('ok');
  });

  it('throws when the response has no token', async () => {
    const { transport } = fakeTransport([{ status: 200, text: '{}' }]);
    await expect(new TokenManager(transport, null).get()).rejects.toThrow(/guest token/);
  });
});
