import { describe, expect, it, vi } from 'vitest';
import { MemoryCache } from '../src/api/cache';
import { RedgifsApi, buildUrl, type ApiStatus, type RequestEvent } from '../src/api/client';
import { ForbiddenEndpointError, HttpError, RateLimitedError, gmTransport, type GmRequest, type HttpRequest, type HttpResponse, type Transport } from '../src/api/http';
import { LOW_PAUSED_KEY, RATE_LIMIT_KEY } from '../src/api/budget';
import { RequestQueue, type Clock } from '../src/api/queue';

const AUTH = 'https://api.redgifs.com/v2/auth/temporary';

function fakeClock(start = 1_000_000): Clock & { t: number } {
  const clock = {
    t: start,
    now: () => clock.t,
    sleep: async (ms: number) => { clock.t += ms; },
  };
  return clock;
}

type Reply = HttpResponse | Error;

/** Auth calls get numbered tokens; other URLs are answered from `script` in order (last repeats). */
function setup(script: Reply[], opts: { cache?: boolean; storage?: Pick<Storage, 'getItem' | 'setItem'>; backoffMs?: number[]; onRequest?: (event: RequestEvent) => void } = {}) {
  const calls: HttpRequest[] = [];
  let tokenN = 0;
  let apiN = 0;
  const transport: Transport = async (req) => {
    calls.push(req);
    if (req.url === AUTH) return { status: 200, text: JSON.stringify({ token: `tok${++tokenN}` }) };
    const reply = script[Math.min(apiN++, script.length - 1)];
    if (reply instanceof Error) throw reply;
    return reply;
  };
  const clock = fakeClock();
  const api = new RedgifsApi({
    transport,
    clock,
    cache: opts.cache ? new MemoryCache(() => clock.now()) : null,
    queue: new RequestQueue({ concurrency: 2, minIntervalMs: 0, clock, storage: opts.storage }),
    storage: opts.storage,
    backoffMs: opts.backoffMs,
    onRequest: opts.onRequest,
  });
  const apiCalls = () => calls.filter((c) => c.url !== AUTH);
  return { api, calls, apiCalls, clock };
}

const ok = (body: unknown): HttpResponse => ({ status: 200, text: JSON.stringify(body) });
const status = (code: number): HttpResponse => ({ status: code, text: '' });

describe('buildUrl', () => {
  it('sorts params and drops undefined/empty values', () => {
    expect(buildUrl('/v2/gifs/search', { type: 'g', order: 'top7', page: 2, tags: undefined, q: '' }))
      .toBe('https://api.redgifs.com/v2/gifs/search?order=top7&page=2&type=g');
  });
  it('keeps 0 and encodes values', () => {
    expect(buildUrl('/v2/x', { n: 0, t: 'a b,c' })).toBe('https://api.redgifs.com/v2/x?n=0&t=a+b%2Cc');
  });
  it('has no query for no params', () => {
    expect(buildUrl('/v2/x')).toBe('https://api.redgifs.com/v2/x');
  });
});

describe('RedgifsApi.searchGifs', () => {
  const page = { gifs: [{ id: 'a' }], page: 2, pages: 5, total: 99, users: [{ username: 'u' }], boosted_gifs: [{ id: 'ad' }], promoted_gifs: [{ id: 'ad2' }] };

  it('sends the right URL with a Bearer token and drops ads', async () => {
    const { api, apiCalls } = setup([ok(page)]);
    const result = await api.searchGifs({ order: 'latest', type: 'i', count: 40, page: 2, tags: ['red hair', 'blue'] });
    expect(apiCalls()).toHaveLength(1);
    expect(apiCalls()[0].url).toBe('https://api.redgifs.com/v2/gifs/search?count=40&order=latest&page=2&tags=red+hair%2Cblue&type=i');
    expect(apiCalls()[0].headers.Authorization).toBe('Bearer tok1');
    expect(result).toEqual({ gifs: [{ id: 'a' }], page: 2, pages: 5, total: 99, users: [{ username: 'u' }] });
    expect(result).not.toHaveProperty('boosted_gifs');
    expect(result).not.toHaveProperty('promoted_gifs');
  });

  it('uses defaults and omits empty tags', async () => {
    const { api, apiCalls } = setup([ok({})]);
    const result = await api.searchGifs({ tags: [] });
    expect(apiCalls()[0].url).toBe('https://api.redgifs.com/v2/gifs/search?count=100&order=trending&page=1&type=g');
    expect(result).toEqual({ gifs: [], page: 1, pages: 0, total: 0, users: [] });
  });
});

describe('RedgifsApi.userGifs', () => {
  it('hits /v2/users/:name/search and drops ads', async () => {
    const { api, apiCalls } = setup([ok({ gifs: [{ id: 'a' }], page: 1, pages: 3, total: 30, users: [], boosted_gifs: [{ id: 'ad' }] })]);
    const result = await api.userGifs('Some User', { count: 12, page: 1, order: 'latest', type: 'g' });
    expect(apiCalls()[0].url).toBe('https://api.redgifs.com/v2/users/Some%20User/search?count=12&order=latest&page=1&type=g');
    expect(apiCalls()[0].headers.Authorization).toBe('Bearer tok1');
    expect(result).toEqual({ gifs: [{ id: 'a' }], page: 1, pages: 3, total: 30, users: [] });
  });
  it('uses defaults and tolerates an empty reply', async () => {
    const { api, apiCalls } = setup([ok({})]);
    const result = await api.userGifs('bob');
    expect(apiCalls()[0].url).toBe('https://api.redgifs.com/v2/users/bob/search?count=100&order=latest&page=1&type=g');
    expect(result).toEqual({ gifs: [], page: 1, pages: 0, total: 0, users: [] });
  });
});

describe('RedgifsApi.getGif', () => {
  it('hits /v2/gifs/:id with niches and users', async () => {
    const { api, apiCalls } = setup([ok({ gif: { id: 'abc' }, user: { username: 'u' } })]);
    const result = await api.getGif('abc');
    expect(apiCalls()[0].url).toBe('https://api.redgifs.com/v2/gifs/abc?niches=yes&users=yes');
    expect(result).toEqual({ gif: { id: 'abc' }, user: { username: 'u' } });
  });
  it('returns null user when absent', async () => {
    const { api } = setup([ok({ gif: { id: 'abc' } })]);
    expect((await api.getGif('abc')).user).toBeNull();
  });
});

describe('caching and dedupe', () => {
  it('serves the second call from cache', async () => {
    const { api, apiCalls } = setup([ok({ gifs: [] })], { cache: true });
    await api.searchGifs();
    await api.searchGifs();
    expect(apiCalls()).toHaveLength(1);
  });

  it('ttl 0 bypasses the cache', async () => {
    const { api, apiCalls } = setup([ok({ v: 1 })], { cache: true });
    await api.getJson('/v2/x', {}, { ttlMs: 0 });
    await api.getJson('/v2/x', {}, { ttlMs: 0 });
    expect(apiCalls()).toHaveLength(2);
  });

  it('refetches once the cache entry is older than ttl', async () => {
    const { api, apiCalls, clock } = setup([ok({ v: 1 })], { cache: true });
    await api.getJson('/v2/x', {}, { ttlMs: 1000 });
    clock.t += 2000;
    await api.getJson('/v2/x', {}, { ttlMs: 1000 });
    expect(apiCalls()).toHaveLength(2);
  });

  it('dedupes identical concurrent calls', async () => {
    const { api, apiCalls } = setup([ok({ v: 1 })]);
    const [a, b, c] = await Promise.all([api.getJson('/v2/x', { a: 1 }), api.getJson('/v2/x', { a: 1 }), api.getJson('/v2/x', { a: 2 })]);
    expect(a).toEqual(b);
    expect(c).toEqual({ v: 1 });
    expect(apiCalls()).toHaveLength(2);
  });
});

/** Transport whose API replies are held until `release()`; concurrency 1 so extra calls wait in the queue. */
function gatedSetup(onRequest?: (event: RequestEvent) => void) {
  const calls: HttpRequest[] = [];
  const gates: Array<() => void> = [];
  const transport: Transport = async (req) => {
    calls.push(req);
    if (req.url === AUTH) return { status: 200, text: JSON.stringify({ token: 'tok' }) };
    await new Promise<void>((resolve) => gates.push(resolve));
    return ok({ url: req.url });
  };
  const clock = fakeClock();
  const api = new RedgifsApi({
    transport,
    clock,
    cache: new MemoryCache(() => clock.now()),
    queue: new RequestQueue({ concurrency: 1, minIntervalMs: 0, clock }),
    onRequest,
  });
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const apiCalls = () => calls.filter((c) => c.url !== AUTH);
  return { api, apiCalls, gates, flush };
}

describe('abort and dedupe semantics', () => {
  it('rejects at once for an already-aborted signal, without a request', async () => {
    const { api, calls } = setup([ok({})]);
    const c = new AbortController();
    c.abort();
    await expect(api.getJson('/v2/x', {}, { signal: c.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(0);
  });

  it('aborting a request still waiting in the queue cancels it and frees the in-flight slot', async () => {
    const { api, apiCalls, gates, flush } = gatedSetup();
    const first = api.getJson('/v2/first');
    await flush();
    const c = new AbortController();
    const second = api.getJson('/v2/second', {}, { signal: c.signal });
    await flush();
    c.abort();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    gates.shift()!();
    await first;
    await flush();
    expect(apiCalls().map((r) => r.url)).toEqual(['https://api.redgifs.com/v2/first']);
    // A later caller starts fresh instead of joining the aborted request.
    const again = api.getJson('/v2/second');
    await flush();
    gates.shift()!();
    await expect(again).resolves.toEqual({ url: 'https://api.redgifs.com/v2/second' });
    expect(apiCalls()).toHaveLength(2);
  });

  it('does not cancel a request that has started: it completes and is cached', async () => {
    const { api, apiCalls, gates, flush } = gatedSetup();
    const c = new AbortController();
    const pending = api.getJson('/v2/x', {}, { signal: c.signal });
    await flush();
    expect(gates).toHaveLength(1);
    c.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    gates.shift()!();
    await flush();
    // Served from the cache: no second API call.
    await expect(api.getJson('/v2/x')).resolves.toEqual({ url: 'https://api.redgifs.com/v2/x' });
    expect(apiCalls()).toHaveLength(1);
  });

  it('a shared request is cancelled only when every caller aborted', async () => {
    const { api, apiCalls, gates, flush } = gatedSetup();
    const blocker = api.getJson('/v2/blocker');
    await flush();
    const a = new AbortController();
    const b = new AbortController();
    const pa = api.getJson('/v2/shared', {}, { signal: a.signal });
    const pb = api.getJson('/v2/shared', {}, { signal: b.signal });
    await flush();
    a.abort();
    await expect(pa).rejects.toMatchObject({ name: 'AbortError' });
    gates.shift()!(); // blocker finishes; the shared request starts for b
    await blocker;
    await flush();
    gates.shift()!();
    await expect(pb).resolves.toEqual({ url: 'https://api.redgifs.com/v2/shared' });
    expect(apiCalls()).toHaveLength(2);
  });

  it('a caller without a signal keeps the shared request alive when the others abort', async () => {
    const { api, gates, flush } = gatedSetup();
    const blocker = api.getJson('/v2/blocker');
    await flush();
    const a = new AbortController();
    const pa = api.getJson('/v2/shared', {}, { signal: a.signal });
    const plain = api.getJson('/v2/shared');
    await flush();
    a.abort();
    await expect(pa).rejects.toMatchObject({ name: 'AbortError' });
    gates.shift()!();
    await blocker;
    await flush();
    gates.shift()!();
    await expect(plain).resolves.toEqual({ url: 'https://api.redgifs.com/v2/shared' });
  });

  it('passes priority through: low requests wait behind high ones', async () => {
    const { api, apiCalls, gates, flush } = gatedSetup();
    const blocker = api.getJson('/v2/blocker');
    await flush();
    const low = api.getJson('/v2/low', {}, { priority: 'low' });
    const high = api.getJson('/v2/high');
    await flush();
    gates.shift()!();
    await blocker;
    await flush();
    gates.shift()!();
    await flush();
    gates.shift()!();
    await Promise.all([low, high]);
    expect(apiCalls().map((r) => r.url.split('/').pop())).toEqual(['blocker', 'high', 'low']);
  });

  it('searchGifs accepts a signal and keeps its return shape', async () => {
    const { api } = setup([ok({ gifs: [{ id: 'a' }], page: 1, pages: 2, total: 3, users: [] })]);
    const c = new AbortController();
    expect(await api.searchGifs({}, { signal: c.signal, priority: 'low' })).toEqual({ gifs: [{ id: 'a' }], page: 1, pages: 2, total: 3, users: [] });
    c.abort();
    await expect(api.searchGifs({ page: 2 }, { signal: c.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('matchTag', () => {
  it('returns RedGifs spelling and queries with the normalized key', async () => {
    const { api, apiCalls } = setup([ok(['Big Tits'])]);
    expect(await api.matchTag('Big_Tits ')).toBe('Big Tits');
    expect(apiCalls()[0].url).toBe('https://api.redgifs.com/v1/tags/match?query=big+tits');
  });

  it('matches case-insensitively and picks the entry whose key equals the query', async () => {
    const { api } = setup([ok(['Big Tits Milf', 'BIG TITS'])]);
    expect(await api.matchTag('big tits')).toBe('BIG TITS');
  });

  it('returns null for an empty list, no equal entry, or a non-array reply', async () => {
    expect(await setup([ok([])]).api.matchTag('nope')).toBeNull();
    expect(await setup([ok(['Other'])]).api.matchTag('nope')).toBeNull();
    expect(await setup([ok({ error: 1 })]).api.matchTag('nope')).toBeNull();
  });

  it('caches for a day and skips the request for an empty name', async () => {
    const { api, apiCalls, clock } = setup([ok(['Big Tits'])], { cache: true });
    await api.matchTag('big tits');
    await api.matchTag('big_tits');
    expect(apiCalls()).toHaveLength(1);
    clock.t += 25 * 60 * 60 * 1000;
    await api.matchTag('big tits');
    expect(apiCalls()).toHaveLength(2);
    expect(await api.matchTag('  ')).toBeNull();
    expect(apiCalls()).toHaveLength(2);
  });
});

describe('suggestTags', () => {
  it('keeps tag entries, coerces counts, and hits the suggest endpoint', async () => {
    const { api, apiCalls } = setup([ok([
      { type: 'tag', text: 'Big Tits', gifs: 6588325 },
      { type: 'creator', text: 'someone', gifs: 5 },
      { type: 'tag', text: 'Big Tits Milf', gifs: '120' },
      { type: 'tag', text: 'Odd', gifs: 'x' },
      { type: 'tag', gifs: 3 },
      null,
    ])]);
    expect(await api.suggestTags('big tits')).toEqual([
      { text: 'Big Tits', count: 6588325 },
      { text: 'Big Tits Milf', count: 120 },
      { text: 'Odd', count: 0 },
    ]);
    expect(apiCalls()[0].url).toBe('https://api.redgifs.com/v2/search/suggest?query=big+tits');
  });

  it('returns [] for a non-array reply', async () => {
    expect(await setup([ok({})]).api.suggestTags('x')).toEqual([]);
  });

  it('accepts a priority option', async () => {
    const { api, apiCalls, gates, flush } = gatedSetup();
    const blocker = api.getJson('/v2/blocker');
    await flush();
    const low = api.suggestTags('low', { priority: 'low' });
    const high = api.getJson('/v2/high');
    await flush();
    gates.shift()!();
    await blocker;
    await flush();
    gates.shift()!();
    await flush();
    gates.shift()!();
    await Promise.all([low, high]);
    expect(apiCalls().map((r) => r.url.split('/').pop()?.split('?')[0])).toEqual(['blocker', 'high', 'suggest']);
  });
});

describe('auth retries', () => {
  it('on 401 refreshes the token and retries', async () => {
    const { api, apiCalls } = setup([status(401), ok({ v: 1 })]);
    expect(await api.getJson('/v2/x')).toEqual({ v: 1 });
    expect(apiCalls().map((c) => c.headers.Authorization)).toEqual(['Bearer tok1', 'Bearer tok2']);
  });

  it('gives up with HttpError after 3 attempts total', async () => {
    const { api, apiCalls } = setup([status(401)]);
    const err: any = await api.getJson('/v2/x').catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(401);
    expect(apiCalls()).toHaveLength(3);
    expect(apiCalls().map((c) => c.headers.Authorization)).toEqual(['Bearer tok1', 'Bearer tok2', 'Bearer tok3']);
  });
});

describe('rate limiting', () => {
  it('on 429 reports rateLimitedUntil, retries and clears status', async () => {
    const { api, apiCalls, clock } = setup([status(429), ok({ v: 1 })]);
    const seen: ApiStatus[] = [];
    api.onStatus((s) => seen.push({ ...s }));
    const start = clock.now();
    expect(await api.getJson('/v2/x')).toEqual({ v: 1 });
    expect(apiCalls()).toHaveLength(2);
    expect(seen[0].rateLimitedUntil).toBe(start + 60_000);
    expect(seen[0].rateLimitedUntil).toBeGreaterThan(start);
    expect(seen[0].gaveUp).toBe(false);
    expect(seen[seen.length - 1]).toEqual({ rateLimitedUntil: 0, gaveUp: false });
    expect(api.status).toEqual({ rateLimitedUntil: 0, gaveUp: false });
    expect(clock.now()).toBeGreaterThanOrEqual(start + 60_000);
  });

  it('repeated 429 beyond the backoff list gives up with RateLimitedError', async () => {
    const { api, apiCalls, clock } = setup([status(429)]);
    const seen: ApiStatus[] = [];
    api.onStatus((s) => seen.push({ ...s }));
    const err: any = await api.getJson('/v2/x').catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(apiCalls()).toHaveLength(3);
    expect(api.status.gaveUp).toBe(true);
    expect(api.status.rateLimitedUntil).toBeGreaterThan(clock.now());
    expect(err.retryAt).toBe(api.status.rateLimitedUntil);
    expect(seen.at(-1)?.gaveUp).toBe(true);
  });

  it('backs off 60 s, then 180 s, then pauses for 10 minutes', async () => {
    const { api, clock } = setup([status(429)]);
    const seen: ApiStatus[] = [];
    api.onStatus((s) => seen.push({ ...s }));
    const start = clock.now();
    const err: any = await api.getJson('/v2/x').catch((e) => e);
    // First pause ends 60 s in; the retry starts then and the second pause ends 180 s later;
    // the third 429 gives up with a 10-minute pause.
    expect(seen.map((s) => s.rateLimitedUntil - start)).toEqual([60_000, 240_000, 840_000]);
    expect(err.retryAt - clock.now()).toBe(600_000);
  });

  it('stores the pause for other tabs and blocks low priority for 15 minutes', async () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
    const { api, clock } = setup([status(429)], { storage });
    const start = clock.now();
    const err: any = await api.getJson('/v2/x').catch((e) => e);
    expect(Number(data.get(RATE_LIMIT_KEY))).toBe(err.retryAt);
    expect(Number(data.get(LOW_PAUSED_KEY))).toBe(start + 240_000 + 15 * 60_000); // from the last 429, which came 240 s in
  });

  it('writes the stored pause on the first 429', async () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
    const { api, clock } = setup([status(429), ok({ v: 1 })], { storage });
    const start = clock.now();
    await api.getJson('/v2/x');
    expect(Number(data.get(RATE_LIMIT_KEY))).toBe(start + 60_000);
  });

  it('respects a custom backoff list', async () => {
    const { api, apiCalls } = setup([status(429)], { backoffMs: [10] });
    await expect(api.getJson('/v2/x')).rejects.toBeInstanceOf(RateLimitedError);
    expect(apiCalls()).toHaveLength(2);
  });
});

describe('server and network errors', () => {
  it('retries a 500 once', async () => {
    const { api, apiCalls } = setup([status(500), ok({ v: 1 })]);
    expect(await api.getJson('/v2/x')).toEqual({ v: 1 });
    expect(apiCalls()).toHaveLength(2);
  });

  it('throws HttpError after a second 500', async () => {
    const { api, apiCalls } = setup([status(500)]);
    await expect(api.getJson('/v2/x')).rejects.toMatchObject({ name: 'HttpError', status: 500 });
    expect(apiCalls()).toHaveLength(2);
  });

  it('does not retry a 404', async () => {
    const { api, apiCalls } = setup([status(404)]);
    await expect(api.getJson('/v2/x')).rejects.toBeInstanceOf(HttpError);
    expect(apiCalls()).toHaveLength(1);
  });

  it('retries a transport failure once, then rethrows', async () => {
    const good = setup([new Error('net'), ok({ v: 1 })]);
    expect(await good.api.getJson('/v2/x')).toEqual({ v: 1 });
    const bad = setup([new Error('net')]);
    await expect(bad.api.getJson('/v2/x')).rejects.toThrow('net');
    expect(bad.apiCalls()).toHaveLength(2);
  });

  it('does not cache failures', async () => {
    const { api, apiCalls } = setup([status(404), ok({ v: 1 })], { cache: true });
    await expect(api.getJson('/v2/x')).rejects.toBeInstanceOf(HttpError);
    expect(await api.getJson('/v2/x')).toEqual({ v: 1 });
    expect(apiCalls()).toHaveLength(2);
  });
});

describe('guard integration', () => {
  it('refuses forbidden endpoints without touching the transport', async () => {
    const { api, calls } = setup([ok({})]);
    await expect(api.getJson('/v2/metrics/gifs/x')).rejects.toBeInstanceOf(ForbiddenEndpointError);
    await expect(api.getJson('/v2/events/track')).rejects.toBeInstanceOf(ForbiddenEndpointError);
    expect(calls).toHaveLength(0);
  });
});

describe('request events (debug hook)', () => {
  it('emits an ok event with path, priority and waitMs/durationMs from the fake clock', async () => {
    const events: RequestEvent[] = [];
    const clock = fakeClock();
    const transport: Transport = async (req) => {
      if (req.url === AUTH) return { status: 200, text: JSON.stringify({ token: 'tok' }) };
      clock.t += 300; // each API reply takes 300 ms of fake time
      return ok({ url: req.url });
    };
    const api = new RedgifsApi({
      transport,
      clock,
      cache: null,
      queue: new RequestQueue({ concurrency: 1, minIntervalMs: 0, clock }),
      onRequest: (event) => events.push(event),
    });
    // One slot: the second request waits for the first (300 ms) before it starts.
    await Promise.all([
      api.getJson('/v2/first', { x: 1 }),
      api.getJson('/v2/second', {}, { priority: 'low' }),
    ]);
    expect(events).toEqual([
      { path: '/v2/first?x=1', priority: 'high', waitMs: 0, durationMs: 300, outcome: 'ok', rateLimited: false },
      { path: '/v2/second', priority: 'low', waitMs: 300, durationMs: 300, outcome: 'ok', rateLimited: false },
    ]);
  });

  it('marks rateLimited when a 429 was seen before the retry succeeded', async () => {
    const events: RequestEvent[] = [];
    const { api } = setup([status(429), ok({ v: 1 })], { onRequest: (event) => events.push(event) });
    await api.getJson('/v2/x');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ path: '/v2/x', outcome: 'ok', rateLimited: true });
  });

  it('emits an error event with the error name and message', async () => {
    const events: RequestEvent[] = [];
    const { api } = setup([status(404)], { onRequest: (event) => events.push(event) });
    await expect(api.getJson('/v2/x')).rejects.toBeInstanceOf(HttpError);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ path: '/v2/x', priority: 'high', outcome: 'error', rateLimited: false, durationMs: 0 });
    expect(events[0].error).toMatch(/^HttpError: HTTP 404/);
  });

  it('emits an aborted event, with zero duration, for a request aborted before it started', async () => {
    const events: RequestEvent[] = [];
    const { api, gates, flush } = gatedSetup((event) => events.push(event));
    const blocker = api.getJson('/v2/blocker');
    await flush();
    const c = new AbortController();
    const second = api.getJson('/v2/second', {}, { signal: c.signal });
    await flush();
    c.abort();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    gates.shift()!();
    await blocker;
    await flush();
    const aborted = events.find((event) => event.path === '/v2/second');
    expect(aborted).toMatchObject({ priority: 'high', durationMs: 0, outcome: 'aborted', rateLimited: false });
    expect(aborted?.error).toMatch(/AbortError/);
  });

  it('emits nothing for a cache hit', async () => {
    const events: RequestEvent[] = [];
    const { api } = setup([ok({ v: 1 })], { cache: true, onRequest: (event) => events.push(event) });
    await api.getJson('/v2/x');
    await api.getJson('/v2/x');
    expect(events).toHaveLength(1);
  });
});

describe('gmTransport', () => {
  it('maps onload to a response and sends request details', async () => {
    const gm = vi.fn((d: Parameters<GmRequest>[0]) => d.onload({ status: 200, responseText: 'hi' }));
    const res = await gmTransport(gm)({ url: 'https://api.redgifs.com/x', headers: { A: 'b' }, timeoutMs: 5 });
    expect(res).toEqual({ status: 200, text: 'hi' });
    expect(gm).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', url: 'https://api.redgifs.com/x', headers: { A: 'b' }, timeout: 5 }));
  });
  it('rejects on error and timeout', async () => {
    const req = { url: 'u', headers: {}, timeoutMs: 1 };
    await expect(gmTransport((d) => d.onerror())(req)).rejects.toThrow(/Network error/);
    await expect(gmTransport((d) => d.ontimeout())(req)).rejects.toThrow(/Timed out/);
  });
});
