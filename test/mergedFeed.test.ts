import { describe, expect, it } from 'vitest';
import type { Gif } from '../src/api/types';
import { createMergedFeed, type CreatorFetcher } from '../src/search/mergedFeed';
import { parseRoute, hrefFor, parsePostSrc } from '../src/router';
import { sourceFromSrc, streamLabel, gridRouteFor } from '../src/ui/postPageHelpers';
import { sourceKey, sourceNeedsLogin } from '../src/ui/postsHelpers';

const gif = (id: string, createDate: number): Gif => ({
  id, userName: 'u', createDate, views: 1, likes: 0, duration: 1, width: 1, height: 1,
  hasAudio: false, type: 1, tags: [], niches: [], description: null, verified: false, urls: {},
});

/** A creator with `items` (already newest first) served `per` per server page; counts calls. */
function creator(items: Gif[], per: number) {
  const calls: number[] = [];
  const fetch: CreatorFetcher = async (page) => {
    calls.push(page);
    const pages = Math.max(1, Math.ceil(items.length / per));
    return { gifs: items.slice((page - 1) * per, page * per), pages };
  };
  return { fetch, calls };
}

/** n gifs with dates start, start-step, ... */
const run = (prefix: string, n: number, start: number, step = 10) =>
  Array.from({ length: n }, (_, i) => gif(`${prefix}${i}`, start - i * step));

const signal = () => new AbortController().signal;

describe('createMergedFeed', () => {
  it('orders across creators by createDate desc, ties by id', async () => {
    const a = creator([gif('a1', 50), gif('a2', 30), gif('a3', 10)], 30);
    const b = creator([gif('b1', 40), gif('b2', 30), gif('b3', 20)], 30);
    const feed = createMergedFeed([a.fetch, b.fetch], 30);
    const page = await feed(1, signal());
    expect(page.gifs.map((g) => g.id)).toEqual(['a1', 'b1', 'a2', 'b2', 'b3', 'a3']);
    expect(page.pages).toBe(1);
  });

  it('dedupes by id across creators', async () => {
    const a = creator([gif('x', 50), gif('a', 30)], 30);
    const b = creator([gif('x', 50), gif('b', 20)], 30);
    const page = await createMergedFeed([a.fetch, b.fetch], 30)(1, signal());
    expect(page.gifs.map((g) => g.id)).toEqual(['x', 'a', 'b']);
  });

  it('builds virtual pages of the page size', async () => {
    const a = creator(run('a', 40, 1000), 30);
    const b = creator(run('b', 40, 995), 30);
    const feed = createMergedFeed([a.fetch, b.fetch], 30);
    const p1 = await feed(1, signal());
    const p2 = await feed(2, signal());
    expect(p1.gifs).toHaveLength(30);
    expect(p2.gifs).toHaveLength(30);
    const all = [...p1.gifs, ...p2.gifs];
    expect(all.map((g) => g.createDate)).toEqual([...all.map((g) => g.createDate)].sort((x, y) => y - x));
    expect(new Set(all.map((g) => g.id)).size).toBe(60);
  });

  it('fetches lazily: one request per creator for page 1, more only when a buffer runs out', async () => {
    const a = creator(run('a', 90, 10_000), 30);
    const b = creator(run('b', 90, 5_000), 30);
    const c = creator(run('c', 90, 4_000), 30);
    const feed = createMergedFeed([a.fetch, b.fetch, c.fetch], 30);
    await feed(1, signal());
    expect(a.calls).toEqual([1]);
    expect(b.calls).toEqual([1]);
    expect(c.calls).toEqual([1]);
    // a (newest) supplies all of page 1; page 2 needs a's second server page, not b's or c's.
    await feed(2, signal());
    expect(a.calls).toEqual([1, 2]);
    expect(b.calls).toEqual([1]);
    expect(c.calls).toEqual([1]);
  });

  it('keeps earlier pages deterministic when pages are asked again or out of order', async () => {
    const a = creator(run('a', 70, 1000, 7), 30);
    const b = creator(run('b', 70, 990, 5), 30);
    const feed = createMergedFeed([a.fetch, b.fetch], 30);
    const first = await feed(1, signal());
    const third = await feed(3, signal());
    const again = await feed(1, signal());
    const second = await feed(2, signal());
    expect(again.gifs.map((g) => g.id)).toEqual(first.gifs.map((g) => g.id));
    const all = [...first.gifs, ...second.gifs, ...third.gifs];
    expect(new Set(all.map((g) => g.id)).size).toBe(all.length);
    const dates = all.map((g) => g.createDate);
    expect(dates).toEqual([...dates].sort((x, y) => y - x));
    const before = a.calls.length + b.calls.length;
    await feed(2, signal());
    expect(a.calls.length + b.calls.length).toBe(before);
  });

  it('reports virtual pages known + 1 until everything is exhausted, then the exact count', async () => {
    const a = creator(run('a', 50, 1000), 30);
    const b = creator(run('b', 20, 500), 30);
    const feed = createMergedFeed([a.fetch, b.fetch], 30);
    const p1 = await feed(1, signal());
    expect(p1.pages).toBe(2);
    const p2 = await feed(2, signal());
    expect(p2.gifs).toHaveLength(30);
    const p3 = await feed(3, signal());
    expect(p3.gifs).toHaveLength(10);
    expect(p3.pages).toBe(3);
    const p4 = await feed(4, signal());
    expect(p4.gifs).toEqual([]);
    expect(p4.pages).toBe(3);
  });

  it('treats an empty creator and an all-empty feed as ended', async () => {
    const none = creator([], 30);
    const page = await createMergedFeed([none.fetch], 30)(1, signal());
    expect(page.gifs).toEqual([]);
    expect(page.pages).toBe(1);
    expect((await createMergedFeed([], 30)(1, signal())).gifs).toEqual([]);
  });

  it('stops a creator at its last page (no request past pages)', async () => {
    const a = creator(run('a', 35, 1000), 30);
    const feed = createMergedFeed([a.fetch], 30);
    await feed(1, signal());
    await feed(2, signal());
    await feed(3, signal());
    expect(a.calls).toEqual([1, 2]);
  });

  it('keeps going on pages=0 until an empty page', async () => {
    const calls: number[] = [];
    const fetch: CreatorFetcher = async (page) => {
      calls.push(page);
      return { gifs: page <= 2 ? run(`p${page}_`, 2, 1000 - page * 100) : [], pages: 0 };
    };
    const page = await createMergedFeed([fetch], 30)(1, signal());
    expect(page.gifs).toHaveLength(4);
    expect(calls).toEqual([1, 2, 3]);
  });

  it('fetches the first pages of all creators in parallel', async () => {
    let inflight = 0;
    let peak = 0;
    const make = (id: string): CreatorFetcher => async () => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return { gifs: [gif(id, 1)], pages: 1 };
    };
    await createMergedFeed([make('a'), make('b'), make('c')], 30)(1, signal());
    expect(peak).toBe(3);
  });

  it('rejects when already aborted or aborted mid-fetch, and recovers afterwards', async () => {
    const controller = new AbortController();
    controller.abort();
    const a = creator(run('a', 5, 100), 30);
    await expect(createMergedFeed([a.fetch], 30)(1, controller.signal)).rejects.toBeDefined();
    expect(a.calls).toEqual([]);

    const live = new AbortController();
    const slow: CreatorFetcher = (_page, sig) => new Promise((resolve, reject) => {
      sig.addEventListener('abort', () => reject(sig.reason ?? new Error('aborted')));
      setTimeout(() => resolve({ gifs: [gif('s', 1)], pages: 1 }), 50);
    });
    const feed2 = createMergedFeed([slow], 30);
    const pending = feed2(1, live.signal);
    live.abort();
    await expect(pending).rejects.toBeDefined();
    const ok = await feed2(1, signal());
    expect(ok.gifs.map((g) => g.id)).toEqual(['s']);
  });

  it('propagates a creator failure and retries that creator next time', async () => {
    let fail = true;
    const flaky: CreatorFetcher = async () => {
      if (fail) throw new Error('boom');
      return { gifs: [gif('f', 5)], pages: 1 };
    };
    const good = creator([gif('g', 9)], 30);
    const feed = createMergedFeed([flaky, good.fetch], 30);
    await expect(feed(1, signal())).rejects.toThrow('boom');
    fail = false;
    const page = await feed(1, signal());
    expect(page.gifs.map((g) => g.id)).toEqual(['g', 'f']);
    expect(good.calls).toEqual([1]);
  });
});

describe('feed routes and sources', () => {
  it('parses and builds /booru/feed', () => {
    expect(parseRoute('/booru/feed')).toEqual({ name: 'feed', tags: '', page: 1 });
    expect(parseRoute('/booru/feed', '?tags=a+b&page=3')).toEqual({ name: 'feed', tags: 'a b', page: 3 });
    expect(hrefFor({ name: 'feed', tags: '', page: 1 })).toBe('/booru/feed');
    expect(hrefFor({ name: 'feed', tags: 'a', page: 2 })).toBe('/booru/feed?tags=a&page=2');
  });

  it('carries src=following on post links', () => {
    expect(parsePostSrc('following')).toBe('following');
    expect(parseRoute('/booru/posts/abc', '?src=following')).toMatchObject({ src: 'following' });
    expect(hrefFor({ name: 'post', id: 'abc', q: '', page: 1, src: 'following' })).toBe('/booru/posts/abc?src=following');
    expect(sourceFromSrc('following')).toEqual({ kind: 'following' });
    expect(streamLabel('following')).toBe('Feed');
    expect(gridRouteFor({ kind: 'following' }, 'x', 2)).toEqual({ name: 'feed', tags: 'x', page: 2 });
    expect(sourceNeedsLogin({ kind: 'following' })).toBe(true);
  });

  it('keys the source by a hash of the sorted followed names', () => {
    const k = (names: string[]) => sourceKey({ kind: 'following', names });
    expect(k(['b', 'A'])).toBe(k(['a', 'B']));
    expect(k(['a'])).not.toBe(k(['a', 'b']));
    expect(k(['a'])).toMatch(/^following:[0-9a-f]+$/);
  });
});
