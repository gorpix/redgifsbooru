import { describe, expect, it } from 'vitest';
import { MemoryCache } from '../src/api/cache';
import { RedgifsApi } from '../src/api/client';
import { HttpError, type HttpRequest, type HttpResponse, type Transport } from '../src/api/http';
import { NICHE_ORDER_KEY, fetchNichePage, readNicheOrder } from '../src/api/nicheOrder';
import { readRules } from '../src/api/normalize';
import { RequestQueue, type Clock } from '../src/api/queue';

const AUTH = 'https://api.redgifs.com/v2/auth/temporary';

function fakeClock(start = 1_000_000): Clock & { t: number } {
  const clock = { t: start, now: () => clock.t, sleep: async (ms: number) => { clock.t += ms; } };
  return clock;
}

type Reply = HttpResponse | Error;
const ok = (body: unknown): HttpResponse => ({ status: 200, text: JSON.stringify(body) });
const status = (code: number): HttpResponse => ({ status: code, text: '' });

function setup(script: Reply[], cache = false) {
  const calls: HttpRequest[] = [];
  let apiN = 0;
  const transport: Transport = async (req) => {
    calls.push(req);
    if (req.url === AUTH) return { status: 200, text: JSON.stringify({ token: 'tok' }) };
    const reply = script[Math.min(apiN++, script.length - 1)];
    if (reply instanceof Error) throw reply;
    return reply;
  };
  const clock = fakeClock();
  const api = new RedgifsApi({
    transport,
    clock,
    cache: cache ? new MemoryCache(() => clock.now()) : null,
    queue: new RequestQueue({ concurrency: 2, minIntervalMs: 0, clock }),
  });
  return { api, apiCalls: () => calls.filter((c) => c.url !== AUTH) };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    data,
  };
}

describe('RedgifsApi.tagWiki', () => {
  it('GETs /v2/tags/:name and shapes the reply', async () => {
    const { api, apiCalls } = setup([ok({ tag: 'Big Tits', description: 'Large.', related: ['Busty', 7, 'Curvy'] })]);
    const wiki = await api.tagWiki('Big Tits');
    expect(apiCalls()[0].url).toBe('https://api.redgifs.com/v2/tags/Big%20Tits');
    expect(wiki).toEqual({ tag: 'Big Tits', description: 'Large.', related: ['Busty', 'Curvy'] });
  });
  it('treats a missing description as null and tolerates garbage', async () => {
    const { api } = setup([ok({ description: '  ' })]);
    expect(await api.tagWiki('x')).toEqual({ tag: 'x', description: null, related: [] });
  });
  it('returns null on 404 but throws other errors', async () => {
    expect(await setup([status(404)]).api.tagWiki('nope')).toBeNull();
    await expect(setup([status(500)]).api.tagWiki('x')).rejects.toBeInstanceOf(HttpError);
  });
  it('is cached for a day', async () => {
    const { api, apiCalls } = setup([ok({ tag: 'a', description: null, related: [] })], true);
    await api.tagWiki('a');
    await api.tagWiki('a');
    expect(apiCalls()).toHaveLength(1);
  });
});

describe('RedgifsApi.userProfile', () => {
  const raw = {
    username: 'bob', name: 'Bob', description: 'Hi', followers: 1200, following: 3, gifs: 50, publishedGifs: 42,
    profileImageUrl: 'https://img/x.jpg', profileUrl: 'https://p', creationtime: 1700000000, verified: true,
    socialUrl1: 'https://a.example', socialUrl2: '', socialUrl3: 'b.example',
  };
  it('hits /v1/users/:name and normalizes', async () => {
    const { api, apiCalls } = setup([ok(raw)]);
    const profile = await api.userProfile('bob');
    expect(apiCalls()[0].url).toBe('https://api.redgifs.com/v1/users/bob');
    expect(profile).toEqual({
      username: 'bob', name: 'Bob', description: 'Hi', followers: 1200, following: 3, posts: 42,
      profileImageUrl: 'https://img/x.jpg', profileUrl: 'https://p', createdAt: 1700000000, verified: true,
      socials: ['https://a.example', 'b.example'],
    });
  });
  it('reads defensively: falls back to gifs, name and the asked-for name, tolerates ms timestamps', async () => {
    const { api } = setup([ok({ gifs: 9, creationtime: 1700000000000 })]);
    expect(await api.userProfile('zed')).toMatchObject({ username: 'zed', name: null, posts: 9, createdAt: 1700000000, verified: false, socials: [], followers: null });
  });
  it('returns null for 404', async () => {
    expect(await setup([status(404)]).api.userProfile('nobody')).toBeNull();
  });
  it('encodes the name', async () => {
    const { api, apiCalls } = setup([ok({})]);
    await api.userProfile('a b/c');
    expect(apiCalls()[0].url).toBe('https://api.redgifs.com/v1/users/a%20b%2Fc');
  });
});

describe('RedgifsApi.niches / niche', () => {
  it('lists niches with count and page', async () => {
    const { api, apiCalls } = setup([ok({
      page: 2, pages: 37, total: 1836,
      niches: [{ id: 'pale-girls', name: 'pale-girls', gifs: 1000, subscribers: 50, tags: ['pale'], thumbnail: 'https://t', preferences: {} }, { nope: 1 }],
    })]);
    const page = await api.niches({ count: 50, page: 2 });
    expect(apiCalls()[0].url).toBe('https://api.redgifs.com/v2/niches?count=50&page=2');
    expect(page).toEqual({
      page: 2, pages: 37, total: 1836,
      niches: [{ id: 'pale-girls', name: 'pale-girls', gifs: 1000, subscribers: 50, tags: ['pale'], thumbnail: 'https://t' }],
    });
  });
  it('defaults to 50 per page, page 1, and survives an empty reply', async () => {
    const { api, apiCalls } = setup([ok({})]);
    expect(await api.niches()).toEqual({ page: 1, pages: 0, total: 0, niches: [] });
    expect(apiCalls()[0].url).toBe('https://api.redgifs.com/v2/niches?count=50&page=1');
  });
  it('reads one niche (rules as strings or objects) and returns null for 404', async () => {
    const body = { niche: { id: 'x', name: 'x', description: 'D', cover: 'c', thumbnail: 't', gifs: 5, subscribers: 2, owner: { username: 'boss' }, rules: ['No ads', { title: 'Be kind', description: 'Always' }], tags: ['a'] } };
    const { api, apiCalls } = setup([ok(body)]);
    expect(await api.niche('x')).toEqual({ id: 'x', name: 'x', gifs: 5, subscribers: 2, tags: ['a'], thumbnail: 't', description: 'D', cover: 'c', owner: 'boss', rules: ['No ads', 'Be kind: Always'] });
    expect(apiCalls()[0].url).toBe('https://api.redgifs.com/v2/niches/x');
    expect(await setup([status(404)]).api.niche('nope')).toBeNull();
    expect(await setup([ok({})]).api.niche('nope')).toBeNull();
  });
  it('readRules accepts a newline separated string', () => {
    expect(readRules('one\n\ntwo')).toEqual(['one', 'two']);
    expect(readRules(null)).toEqual([]);
  });
});

describe('RedgifsApi.nicheGifs', () => {
  it('hits /v2/niches/:id/gifs, drops ads and keeps the uncapped total', async () => {
    const { api, apiCalls } = setup([ok({ gifs: [{ id: 'a' }], page: 1, pages: 1380, total: 138000, users: [], boosted_gifs: [{ id: 'ad' }], promoted_gifs: [{ id: 'ad2' }] })]);
    const page = await api.nicheGifs('pale-girls', { order: 'latest', count: 100, page: 1 });
    expect(apiCalls()[0].url).toBe('https://api.redgifs.com/v2/niches/pale-girls/gifs?count=100&order=latest&page=1');
    expect(page).toEqual({ gifs: [{ id: 'a' }], page: 1, pages: 1380, total: 138000, users: [] });
  });
  it('defaults to trending, 100 per page', async () => {
    const { api, apiCalls } = setup([ok({})]);
    expect(await api.nicheGifs('x')).toEqual({ gifs: [], page: 1, pages: 0, total: 0, users: [] });
    expect(apiCalls()[0].url).toBe('https://api.redgifs.com/v2/niches/x/gifs?count=100&order=trending&page=1');
  });
});

describe('RedgifsApi.userGifs tags', () => {
  it('sends tags comma separated', async () => {
    const { api, apiCalls } = setup([ok({})]);
    await api.userGifs('bob', { tags: ['red hair', 'blue'], count: 100 });
    expect(apiCalls()[0].url).toBe('https://api.redgifs.com/v2/users/bob/search?count=100&order=latest&page=1&tags=red+hair%2Cblue&type=g');
  });
});

describe('fetchNichePage order probing', () => {
  const good = { gifs: [{ id: 'a' }], page: 1, pages: 2, total: 150 };

  it('uses trending when accepted and remembers it', async () => {
    const { api, apiCalls } = setup([ok(good)]);
    const storage = memoryStorage();
    const page = await fetchNichePage(api, 'x', { count: 100, page: 1 }, {}, storage);
    expect(page.total).toBe(150);
    expect(apiCalls()).toHaveLength(1);
    expect(apiCalls()[0].url).toContain('order=trending');
    expect(storage.data.get(NICHE_ORDER_KEY)).toBe('trending');
  });

  it('falls back to latest on an HTTP rejection and remembers it', async () => {
    const { api, apiCalls } = setup([status(400), ok(good)]);
    const storage = memoryStorage();
    const page = await fetchNichePage(api, 'x', { page: 1 }, {}, storage);
    expect(page.gifs).toHaveLength(1);
    expect(apiCalls().map((c) => /order=(\w+)/.exec(c.url)?.[1])).toEqual(['trending', 'latest']);
    expect(readNicheOrder(storage)).toBe('latest');
  });

  it('falls back to latest when trending answers empty with total 0', async () => {
    const { api, apiCalls } = setup([ok({ gifs: [], pages: 0, total: 0 }), ok(good)]);
    const storage = memoryStorage();
    await fetchNichePage(api, 'x', {}, {}, storage);
    expect(apiCalls()).toHaveLength(2);
    expect(storage.data.get(NICHE_ORDER_KEY)).toBe('latest');
  });

  it('does not probe again once remembered', async () => {
    const { api, apiCalls } = setup([ok(good)]);
    await fetchNichePage(api, 'x', { page: 3 }, {}, memoryStorage({ [NICHE_ORDER_KEY]: 'latest' }));
    expect(apiCalls()).toHaveLength(1);
    expect(apiCalls()[0].url).toContain('order=latest');
  });

  it('passes an explicit non-trending order straight through and remembers nothing', async () => {
    const { api, apiCalls } = setup([ok(good)]);
    const storage = memoryStorage();
    await fetchNichePage(api, 'x', { order: 'top7' }, {}, storage);
    expect(apiCalls()[0].url).toContain('order=top7');
    expect(storage.data.size).toBe(0);
  });

  it('remembers nothing when both orders are empty (an empty niche) and rethrows non-HTTP errors', async () => {
    const { api } = setup([ok({ gifs: [], pages: 0, total: 0 })]);
    const storage = memoryStorage();
    const page = await fetchNichePage(api, 'x', {}, {}, storage);
    expect(page.total).toBe(0);
    expect(storage.data.size).toBe(0);

    const failing = { nicheGifs: async () => { throw new TypeError('network'); } };
    await expect(fetchNichePage(failing as never, 'x', {}, {}, storage)).rejects.toBeInstanceOf(TypeError);
  });

  it('ignores garbage in storage', () => {
    expect(readNicheOrder(memoryStorage({ [NICHE_ORDER_KEY]: 'weird' }))).toBeNull();
    expect(readNicheOrder(null)).toBeNull();
  });
});
