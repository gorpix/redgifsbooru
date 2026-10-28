import { describe, expect, it } from 'vitest';
import { AuthManager, type AuthDebugEvent, type PageRunner } from '../src/api/auth';
import { MemoryCache, type ResponseCache } from '../src/api/cache';
import { RedgifsApi, isPersonalPath, isWritablePath, type RequestEvent } from '../src/api/client';
import { ForbiddenEndpointError, HttpError, gmTransport, fetchTransport, type GmRequest, type HttpRequest, type HttpResponse, type Transport } from '../src/api/http';
import { RequestQueue, type Clock } from '../src/api/queue';
import { PAGE_CSP } from '../src/takeover';

const API = 'https://api.redgifs.com';
const GUEST_AUTH = `${API}/v2/auth/temporary`;

function fakeClock(start = 1_000_000): Clock & { t: number } {
  const clock = { t: start, now: () => clock.t, sleep: async (ms: number) => { clock.t += ms; } };
  return clock;
}

const ok = (body: unknown): HttpResponse => ({ status: 200, text: JSON.stringify(body) });
const code = (status: number): HttpResponse => ({ status, text: '' });

interface Setup {
  /** Replies for API calls, by "METHOD path+search"; a function or list (last repeats). */
  routes?: Record<string, HttpResponse | HttpResponse[] | ((req: HttpRequest) => HttpResponse | Error)>;
  /** id_tokens handed out by the refresh runner, in order (last repeats); 'logout' = 400. */
  logins?: Array<string | 'logout'>;
  loggedIn?: boolean;
}

async function setup({ routes = {}, logins = ['USER1'], loggedIn = true }: Setup = {}) {
  const clock = fakeClock();
  const calls: HttpRequest[] = [];
  const counters = new Map<string, number>();
  const transport: Transport = async (req) => {
    calls.push(req);
    if (req.url === GUEST_AUTH) return ok({ token: 'GUEST1' });
    const key = `${req.method ?? 'GET'} ${req.url.slice(API.length)}`;
    const route = routes[key] ?? routes[`${req.method ?? 'GET'} ${new URL(req.url).pathname}`];
    if (route === undefined) return ok({});
    if (typeof route === 'function') {
      const r = route(req);
      if (r instanceof Error) throw r;
      return r;
    }
    if (Array.isArray(route)) {
      const n = counters.get(key) ?? 0;
      counters.set(key, n + 1);
      return route[Math.min(n, route.length - 1)];
    }
    return route;
  };
  let loginN = 0;
  const runnerCalls: string[] = [];
  const runner: PageRunner = async (body) => {
    runnerCalls.push(body);
    const next = logins[Math.min(loginN++, logins.length - 1)];
    return next === 'logout' ? { status: 400, json: null } : { status: 200, json: { id_token: next, expires_in: 3600 } };
  };
  const authEvents: AuthDebugEvent[] = [];
  const auth = new AuthManager({ runner, clock, createChannel: () => null, setTimer: () => () => undefined, onDebug: (e) => authEvents.push(e) });
  const cacheSets: string[] = [];
  const inner = new MemoryCache(() => clock.now());
  const cache: ResponseCache = {
    get: (k, age) => inner.get(k, age),
    set: async (k, d) => { cacheSets.push(k); await inner.set(k, d); },
    clear: () => inner.clear(),
  };
  const events: RequestEvent[] = [];
  const api = new RedgifsApi({
    transport, clock, cache, auth,
    queue: new RequestQueue({ concurrency: 2, minIntervalMs: 0, clock }),
    onRequest: (e) => events.push(e),
  });
  if (loggedIn) await auth.refresh();
  const apiCalls = () => calls.filter((c) => c.url !== GUEST_AUTH);
  const callsTo = (method: string, path: string) => apiCalls().filter((c) => (c.method ?? 'GET') === method && c.url.startsWith(API + path));
  return { api, auth, calls, apiCalls, callsTo, clock, cacheSets, runnerCalls, authEvents, events };
}

describe('path classes', () => {
  it('knows personalized and writable paths', () => {
    for (const p of ['/v1/me', '/v1/me/follows', '/v2/me/collections/x/gifs', '/v2/likes', '/v2/feeds/liked']) expect(isPersonalPath(p)).toBe(true);
    for (const p of ['/v2/gifs/search', '/v1/users/bob', '/v2/gifs/abc']) expect(isPersonalPath(p)).toBe(false);
    expect(isWritablePath('/v2/gifs/abc/like')).toBe(true);
    expect(isWritablePath('/v1/me/follows/bob')).toBe(true);
    expect(isWritablePath('/v2/me/collections/1/gifs')).toBe(true);
    expect(isWritablePath('/v2/gifs/search')).toBe(false);
    expect(isWritablePath('/v2/metrics')).toBe(false);
  });
});

describe('token provider', () => {
  it('sends the user id_token when logged in, the guest token otherwise', async () => {
    const user = await setup();
    await user.api.searchGifs();
    expect(user.apiCalls()[0].headers.Authorization).toBe('Bearer USER1');
    expect(user.calls.some((c) => c.url === GUEST_AUTH)).toBe(false);

    const guest = await setup({ loggedIn: false, logins: ['logout'] });
    await guest.auth.refresh();
    await guest.api.searchGifs();
    expect(guest.apiCalls()[0].headers.Authorization).toBe('Bearer GUEST1');
  });

  it('fetches the username through the api after a login', async () => {
    const s = await setup({ routes: { 'GET /v1/me': ok({ username: 'alice', blockedTags: ['x'] }) } });
    await s.auth.refresh(true);
    expect(s.auth.username).toBe('alice');
    expect(s.callsTo('GET', '/v1/me')).toHaveLength(1);
    expect(s.callsTo('GET', '/v1/me')[0].headers.Authorization).toBe('Bearer USER1');
  });
});

describe('401 handling', () => {
  it('refreshes once and retries once for a logged-in user', async () => {
    const s = await setup({
      logins: ['USER1', 'USER2'],
      routes: { 'GET /v2/likes': (req) => (req.headers.Authorization === 'Bearer USER2' ? ok(['a']) : code(401)) },
    });
    expect(await s.api.account.likedIds()).toEqual(['a']);
    expect(s.runnerCalls).toHaveLength(2);
    expect(s.callsTo('GET', '/v2/likes')).toHaveLength(2);
    expect(s.auth.state).toBe('loggedIn');
  });

  it('marks the login as error (not logged out) when the fresh token is refused too', async () => {
    const s = await setup({ logins: ['USER1', 'USER2', 'USER3'], routes: { 'GET /v2/likes': code(401) } });
    await expect(s.api.account.likedIds()).rejects.toBeInstanceOf(HttpError);
    expect(s.callsTo('GET', '/v2/likes')).toHaveLength(2);
    expect(s.runnerCalls).toHaveLength(2);
    expect(s.auth.state).toBe('error');
  });

  it('a public read falls back to the guest token when the user token keeps failing', async () => {
    const s = await setup({
      logins: ['USER1', 'USER2'],
      routes: { 'GET /v2/gifs/search?count=100&order=trending&page=1&type=g': (req) => (req.headers.Authorization === 'Bearer GUEST1' ? ok({ gifs: [{ id: 'g' }] }) : code(401)) },
    });
    const page = await s.api.searchGifs();
    expect(page.gifs).toHaveLength(1);
    expect(s.auth.state).toBe('error');
  });

  it('guest behaviour is unchanged: a 401 gets a new guest token', async () => {
    const s = await setup({ loggedIn: false, logins: ['logout'], routes: { 'GET /v2/gifs/abc?niches=yes&users=yes': [code(401), ok({ gif: { id: 'abc' } })] } });
    await s.auth.refresh();
    expect((await s.api.getGif('abc')).gif.id).toBe('abc');
  });
});

describe('personalized reads', () => {
  it('are never written to the persistent cache and memoized for at most 60 s', async () => {
    const s = await setup({ routes: { 'GET /v2/likes': ok(['a', 'b']), 'GET /v1/me': ok({ username: 'alice' }) } });
    await s.api.account.likedIds();
    await s.api.account.likedIds();
    expect(s.callsTo('GET', '/v2/likes')).toHaveLength(1); // memo
    s.clock.t += 61_000;
    await s.api.account.likedIds();
    expect(s.callsTo('GET', '/v2/likes')).toHaveLength(2);
    expect(s.cacheSets.filter((k) => /\/(v1\/me|v2\/me|v2\/likes|v2\/feeds\/liked)/.test(k))).toEqual([]);
  });

  it('public responses are still cached', async () => {
    const s = await setup({ routes: { 'GET /v2/gifs/search?count=100&order=trending&page=1&type=g': ok({ gifs: [] }) } });
    await s.api.searchGifs();
    await s.api.searchGifs();
    expect(s.cacheSets).toHaveLength(1);
    expect(s.apiCalls().filter((c) => c.url.includes('/search'))).toHaveLength(1);
  });

  it('a login change drops the memo', async () => {
    const s = await setup({ routes: { 'GET /v2/likes': ok(['a']) } });
    await s.api.account.likedIds();
    s.auth.markError();
    await s.auth.refresh(true);
    await s.api.account.likedIds();
    expect(s.callsTo('GET', '/v2/likes')).toHaveLength(2);
  });

  it('need a login: no network call and a 401 when logged out', async () => {
    const s = await setup({ loggedIn: false, logins: ['logout'] });
    await s.auth.refresh();
    await expect(s.api.account.likedIds()).rejects.toMatchObject({ status: 401 });
    expect(s.apiCalls()).toHaveLength(0);
  });
});

describe('writes', () => {
  it('send the method, body and user token, with a JSON reply parsed', async () => {
    const s = await setup({ routes: { 'POST /v2/me/collections': ok({ folderId: 'c1', folderName: 'n' }) } });
    const reply = await s.api.send('POST', '/v2/me/collections', { folderName: 'n' });
    expect(reply).toEqual({ folderId: 'c1', folderName: 'n' });
    const call = s.callsTo('POST', '/v2/me/collections')[0];
    expect(call.body).toEqual({ folderName: 'n' });
    expect(call.headers.Authorization).toBe('Bearer USER1');
  });

  it('are never cached or de-duplicated, and run at high priority', async () => {
    const s = await setup({ routes: { 'PUT /v2/gifs/a/like': { status: 200, text: '' } } });
    await Promise.all([s.api.send('PUT', '/v2/gifs/a/like', {}), s.api.send('PUT', '/v2/gifs/a/like', {})]);
    expect(s.callsTo('PUT', '/v2/gifs/a/like')).toHaveLength(2);
    expect(s.cacheSets).toEqual([]);
    const writes = s.events.filter((e) => e.path.includes('/like'));
    expect(writes.map((e) => e.priority)).toEqual(['high', 'high']);
  });

  it('are not retried on a network error or a server error', async () => {
    const net = await setup({ routes: { 'PUT /v2/gifs/a/like': () => new Error('net down') } });
    await expect(net.api.send('PUT', '/v2/gifs/a/like', {})).rejects.toThrow('net down');
    expect(net.callsTo('PUT', '/v2/gifs/a/like')).toHaveLength(1);

    const srv = await setup({ routes: { 'PUT /v2/gifs/a/like': code(503) } });
    await expect(srv.api.send('PUT', '/v2/gifs/a/like', {})).rejects.toMatchObject({ status: 503 });
    expect(srv.callsTo('PUT', '/v2/gifs/a/like')).toHaveLength(1);

    const limited = await setup({ routes: { 'PUT /v2/gifs/a/like': code(429) } });
    await expect(limited.api.send('PUT', '/v2/gifs/a/like', {})).rejects.toMatchObject({ name: 'RateLimitedError' });
    expect(limited.callsTo('PUT', '/v2/gifs/a/like')).toHaveLength(1);
  });

  it('retry exactly once after a 401 and a token refresh', async () => {
    const once = await setup({
      logins: ['USER1', 'USER2'],
      routes: { 'PUT /v2/gifs/a/like': (req) => (req.headers.Authorization === 'Bearer USER2' ? ok({}) : code(401)) },
    });
    await once.api.send('PUT', '/v2/gifs/a/like', {});
    expect(once.callsTo('PUT', '/v2/gifs/a/like')).toHaveLength(2);

    const twice = await setup({ logins: ['USER1', 'USER2', 'USER3'], routes: { 'PUT /v2/gifs/a/like': code(401) } });
    await expect(twice.api.send('PUT', '/v2/gifs/a/like', {})).rejects.toMatchObject({ status: 401 });
    expect(twice.callsTo('PUT', '/v2/gifs/a/like')).toHaveLength(2);
    expect(twice.auth.state).toBe('error');
  });

  it('need a login and an allowed path', async () => {
    const out = await setup({ loggedIn: false, logins: ['logout'] });
    await out.auth.refresh();
    await expect(out.api.send('PUT', '/v2/gifs/a/like', {})).rejects.toMatchObject({ status: 401 });
    expect(out.apiCalls()).toHaveLength(0);
    const s = await setup();
    await expect(s.api.send('POST', '/v2/metrics/view', {})).rejects.toBeInstanceOf(ForbiddenEndpointError);
    await expect(s.api.send('DELETE', '/v2/gifs/search', {})).rejects.toBeInstanceOf(ForbiddenEndpointError);
    expect(s.apiCalls().filter((c) => c.method)).toHaveLength(0);
  });

  it('invalidate the related memoized reads, and only those', async () => {
    const s = await setup({
      routes: {
        'GET /v2/likes': ok(['a']), 'GET /v2/feeds/liked?count=30&page=1&type=g': ok({ gifs: [] }),
        'GET /v1/me/follows': ok(['bob']), 'GET /v2/me/collections?count=50&page=1': ok({ collections: [] }),
        'GET /v2/me/collections/c1/gifs?count=100&page=1': ok({ gifs: [] }),
        'PUT /v2/gifs/a/like': ok({}), 'PUT /v1/me/follows/bob': ok({}), 'POST /v2/me/collections/c1/gifs': ok({}),
      },
    });
    const a = s.api.account;
    const readAll = async () => { await a.likedIds(); await a.likedFeed(); await a.followedNames(); await a.collections(); await a.collectionGifs('c1'); };
    await readAll();
    const base = s.apiCalls().filter((c) => (c.method ?? 'GET') === 'GET').length - 5; // the username lookup
    const count = () => s.apiCalls().filter((c) => (c.method ?? 'GET') === 'GET').length - base;
    expect(count()).toBe(5);

    await a.like('a');
    await readAll();
    expect(count()).toBe(5 + 2); // likes + liked feed refetched only

    await a.follow('bob');
    await readAll();
    expect(count()).toBe(5 + 2 + 1);

    await a.addToCollection('c1', 'a');
    await readAll();
    expect(count()).toBe(5 + 2 + 1 + 2); // collections list + that collection's gifs
  });

  it('a read in flight during a write is not memoized as fresh', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const clock = fakeClock();
    let likes = ['a'];
    let first = true;
    const transport: Transport = async (req) => {
      if (req.url === `${API}/v2/likes`) {
        const snapshot = [...likes];
        if (first) { first = false; await gate; }
        return ok(snapshot);
      }
      if (req.method === 'PUT') { likes = ['a', 'b']; return ok({}); }
      return ok({});
    };
    const auth = new AuthManager({ runner: async () => ({ status: 200, json: { id_token: 'U', expires_in: 3600 } }), clock, createChannel: () => null, setTimer: () => () => undefined });
    await auth.refresh();
    const api = new RedgifsApi({ transport, clock, auth, queue: new RequestQueue({ concurrency: 2, minIntervalMs: 0, clock }) });
    const stale = api.account.likedIds();
    await new Promise((r) => setTimeout(r, 0));
    await api.account.like('b');
    release();
    expect(await stale).toEqual(['a']); // the old read finishes for its caller...
    expect(await api.account.likedIds()).toEqual(['a', 'b']); // ...but was not memoized: this refetches
  });
});

describe('account methods', () => {
  const liked = { gifs: [{ id: 'x' }, { id: 'y' }, 'junk'], page: 2, pages: 5, total: 140, users: [{ username: 'u' }, 3] };

  it('me() reads /v1/me defensively', async () => {
    const s = await setup({ routes: { 'GET /v1/me': ok({ username: 'alice', name: 'Alice', blockedTags: ['a', 1, 'b'], profileImageUrl: 'p' }) } });
    expect(await s.api.account.me()).toEqual({ username: 'alice', name: 'Alice', description: null, profileUrl: null, profileImageUrl: 'p', blockedTags: ['a', 'b'] });
  });

  it('likes: list, like, unlike', async () => {
    const s = await setup({ routes: { 'GET /v2/likes': ok(['a', 7, 'b']) } });
    expect(await s.api.account.likedIds()).toEqual(['a', 'b']);
    await s.api.account.like('abc');
    await s.api.account.unlike('abc');
    const [put] = s.callsTo('PUT', '/v2/gifs/abc/like');
    const [del] = s.callsTo('DELETE', '/v2/gifs/abc/like');
    expect(put.body).toEqual({ context: 'booru', source: 'booru', source_id: null, position: 0 });
    expect(del.body).toEqual({ context: 'booru' });
  });

  it('likedFeed uses page/count/type and returns the SearchPage shape', async () => {
    const s = await setup({ routes: { 'GET /v2/feeds/liked?count=30&page=2&type=i': ok(liked) } });
    expect(await s.api.account.likedFeed({ page: 2, type: 'i' })).toEqual({ gifs: [{ id: 'x' }, { id: 'y' }], page: 2, pages: 5, total: 140, users: [{ username: 'u' }] });
    expect(await s.api.account.likedFeed({ page: 3 })).toEqual({ gifs: [], page: 3, pages: 0, total: 0, users: [] });
    expect(s.callsTo('GET', '/v2/feeds/liked')[1].url).toBe(`${API}/v2/feeds/liked?count=30&page=3&type=g`);
  });

  it('follows: list, follow, unfollow', async () => {
    const s = await setup({ routes: { 'GET /v1/me/follows': ok(['bob', { username: 'carol' }, 4]) } });
    expect(await s.api.account.followedNames()).toEqual(['bob', 'carol']);
    await s.api.account.follow('Some User');
    await s.api.account.unfollow('Some User');
    expect(s.callsTo('PUT', '/v1/me/follows/Some%20User')[0].body).toEqual({ source: 'booru', source_id: null, position: 1 });
    const del = s.callsTo('DELETE', '/v1/me/follows/Some%20User')[0];
    expect(del.body).toBeUndefined();
  });

  it('following() reads profiles', async () => {
    const s = await setup({ routes: { 'GET /v2/me/following?count=100&page=1': ok({ items: [{ username: 'bob', followers: 3, publishedGifs: 9 }, {}], page: 1, pages: 1, total: 2 }) } });
    const page = await s.api.account.following();
    expect(page).toMatchObject({ page: 1, pages: 1, total: 2 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ username: 'bob', followers: 3, posts: 9 });
  });

  it('collections: list and one', async () => {
    const col = { folderId: 'c1', folderName: 'Faves', published: true, description: 'd', thumbs: ['t1', { url: 't2' }], contentCount: 4 };
    const s = await setup({
      routes: {
        'GET /v2/me/collections?count=50&page=2': ok({ collections: [col, { nope: 1 }], pages: 3, totalCount: 120 }),
        'GET /v2/me/collections/c1': ok(col),
        'GET /v2/me/collections/zz': code(404),
      },
    });
    const page = await s.api.account.collections({ page: 2 });
    expect(page).toEqual({ collections: [{ id: 'c1', name: 'Faves', description: 'd', published: true, thumbs: ['t1', 't2'], count: 4 }], page: 2, pages: 3, total: 120 });
    expect((await s.api.account.collection('c1'))?.name).toBe('Faves');
    expect(await s.api.account.collection('zz')).toBeNull();
  });

  it('collectionGifs returns the SearchPage shape', async () => {
    const s = await setup({ routes: { 'GET /v2/me/collections/c1/gifs?count=100&page=1': ok(liked) } });
    const page = await s.api.account.collectionGifs('c1');
    expect(page.gifs).toHaveLength(2);
    expect(page).toMatchObject({ page: 2, pages: 5, total: 140 });
  });

  it('collection writes use the contract paths and bodies', async () => {
    const s = await setup({ routes: { 'POST /v2/me/collections': ok({ folderId: 'new1', folderName: 'N', published: false }), 'GET /v2/me/collections/c1': ok({ folderId: 'c1', folderName: 'Old', description: 'od', published: true }) } });
    const a = s.api.account;
    const created = await a.createCollection({ folderName: 'N', description: null, published: false });
    expect(created).toMatchObject({ id: 'new1', name: 'N' });
    expect(s.callsTo('POST', '/v2/me/collections')[0].body).toEqual({ folderName: 'N', description: null, published: false });

    await a.updateCollection('c1', { folderName: 'New', description: 'x', published: false });
    expect(s.callsTo('GET', '/v2/me/collections/c1')).toHaveLength(0); // full patch: no read first
    await a.updateCollection('c1', { published: false }); // partial: filled from the current one
    const patches = s.callsTo('PATCH', '/v2/me/collections/c1');
    expect(patches[0].body).toEqual({ collectionId: 'c1', folderName: 'New', description: 'x', published: false });
    expect(patches[1].body).toEqual({ collectionId: 'c1', folderName: 'Old', description: 'od', published: false });

    await a.addToCollection('c1', 'gif1');
    expect(s.callsTo('POST', '/v2/me/collections/c1/gifs')[0].body).toEqual({ gifId: 'gif1', context: 'booru' });
    await a.removeFromCollection('c1', ['g1', 'g2']);
    expect(s.callsTo('DELETE', '/v2/me/collections/c1/gifs')[0].body).toEqual(['g1', 'g2']);
    await a.deleteCollection('c1');
    const del = s.callsTo('DELETE', '/v2/me/collections/c1').filter((c) => c.url.endsWith('/c1'));
    expect(del).toHaveLength(1);
    expect(del[0].body).toBeUndefined();
  });
});

describe('secrets in debug output', () => {
  it('request events and auth events never contain a token', async () => {
    const s = await setup({ logins: ['USER-SECRET-ONE', 'USER-SECRET-TWO'], routes: { 'GET /v2/likes': (req) => (req.headers.Authorization === 'Bearer USER-SECRET-TWO' ? ok(['a']) : code(401)), 'GET /v1/me': ok({ username: 'alice' }) } });
    await s.api.account.likedIds();
    await s.api.account.like('a').catch(() => undefined);
    s.auth.markError();
    const text = JSON.stringify(s.events) + JSON.stringify(s.authEvents);
    expect(text).not.toMatch(/SECRET/);
    expect(text).not.toMatch(/GUEST1/);
  });
});

describe('transport', () => {
  it('gmTransport sends the method and a JSON body, and stays GET by default', async () => {
    const seen: Array<Parameters<GmRequest>[0]> = [];
    const gm: GmRequest = (details) => { seen.push(details); details.onload({ status: 200, responseText: '{}' }); };
    const t = gmTransport(gm);
    await t({ url: 'https://x/y', headers: { Accept: 'a' }, timeoutMs: 5 });
    await t({ method: 'PATCH', url: 'https://x/y', headers: { Accept: 'a' }, body: { k: 1 }, timeoutMs: 5 });
    await t({ method: 'DELETE', url: 'https://x/y', headers: {}, body: ['a'], timeoutMs: 5 });
    expect(seen[0].method).toBe('GET');
    expect(seen[0].data).toBeUndefined();
    expect(seen[0].headers).toEqual({ Accept: 'a' });
    expect(seen[1]).toMatchObject({ method: 'PATCH', data: '{"k":1}' });
    expect(seen[1].headers['Content-Type']).toBe('application/json');
    expect(seen[2]).toMatchObject({ method: 'DELETE', data: '["a"]' });
  });

  it('fetchTransport does the same', async () => {
    const seen: Array<[string, RequestInit]> = [];
    const fake = (async (url: string, init: RequestInit) => { seen.push([url, init]); return new Response('{}'); }) as unknown as typeof fetch;
    const t = fetchTransport(fake);
    await t({ method: 'POST', url: 'https://x', headers: {}, body: { a: 1 }, timeoutMs: 100 });
    await t({ url: 'https://x', headers: {}, timeoutMs: 100 });
    expect(seen[0][1]).toMatchObject({ method: 'POST', body: '{"a":1}', headers: { 'Content-Type': 'application/json' } });
    expect(seen[1][1].method).toBe('GET');
    expect(seen[1][1].body).toBeUndefined();
  });
});

describe('takeover CSP', () => {
  it('allows only the login host for connections', () => {
    expect(PAGE_CSP).toContain('connect-src https://auth2.redgifs.com;');
    expect(PAGE_CSP).not.toContain("connect-src 'none'");
    expect(PAGE_CSP).toContain("frame-src 'none'");
  });
});
