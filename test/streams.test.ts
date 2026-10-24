import { describe, expect, it, vi } from 'vitest';
import type { Gif } from '../src/api/types';
import type { FetchStreamPage, StreamPage } from '../src/search/filler';
import { combineStreams } from '../src/search/streams';

function gif(id: string, createDate: number): Gif {
  return {
    id, userName: 'u', createDate, views: 1, likes: 0, duration: 1, width: 1, height: 1,
    hasAudio: false, type: 1, tags: [], niches: [], description: null, verified: false, urls: {},
  };
}

/** A fake stream: pages[i] is the gifs of page i+1. */
function stream(pages: Gif[][]): FetchStreamPage {
  return vi.fn(async (page: number): Promise<StreamPage> => ({ gifs: pages[page - 1] ?? [], pages: pages.length }));
}

const signal = new AbortController().signal;
const ids = (r: StreamPage) => r.gifs.map((g) => g.id);

describe('combineStreams', () => {
  it('passes a single stream through unchanged', () => {
    const one = stream([[gif('a', 1)]]);
    expect(combineStreams([one], 'latest')).toBe(one);
  });

  it('orders latest by createDate desc across streams', async () => {
    const s1 = stream([[gif('a', 100), gif('c', 50)]]);
    const s2 = stream([[gif('b', 90), gif('d', 10)]]);
    const res = await combineStreams([s1, s2], 'latest')(1, signal);
    expect(ids(res)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps stream order for other orders', async () => {
    const s1 = stream([[gif('a', 1), gif('c', 3)]]);
    const s2 = stream([[gif('b', 100), gif('d', 4)]]);
    for (const order of ['trending', 'top7', 'top28'] as const) {
      const res = await combineStreams([s1, s2], order)(1, signal);
      expect(ids(res)).toEqual(['a', 'c', 'b', 'd']);
    }
  });

  it('dedupes by id and reports the max page count', async () => {
    const s1 = stream([[gif('a', 5), gif('b', 4)], [gif('x', 1)]]);
    const s2 = stream([[gif('b', 4), gif('c', 3)]]);
    const combined = combineStreams([s1, s2], 'trending');
    const res = await combined(1, signal);
    expect(ids(res)).toEqual(['a', 'b', 'c']);
    expect(res.pages).toBe(2);
  });

  it('skips streams that have ended', async () => {
    const s1 = stream([[gif('a', 3)], [gif('b', 2)], [gif('c', 1)]]);
    const s2 = stream([[gif('d', 9)]]); // one page only
    const combined = combineStreams([s1, s2], 'trending');
    await combined(1, signal);
    expect(s2).toHaveBeenCalledTimes(1);
    const second = await combined(2, signal);
    expect(ids(second)).toEqual(['b']);
    expect(s2).toHaveBeenCalledTimes(1); // page 2 > its 1 page: not fetched again
    expect(s1).toHaveBeenCalledTimes(2);
  });

  it('skips a stream after an empty page', async () => {
    const empty: FetchStreamPage = vi.fn(async () => ({ gifs: [], pages: 5 }));
    const s1 = stream([[gif('a', 1)], [gif('b', 1)], [gif('c', 1)]]);
    const combined = combineStreams([empty, s1], 'trending');
    await combined(1, signal);
    await combined(2, signal);
    expect(empty).toHaveBeenCalledTimes(1);
  });

  it('still serves earlier pages of an ended stream when asked again', async () => {
    const s1 = stream([[gif('a', 1)], [gif('b', 1)]]);
    const s2 = stream([[gif('c', 1)]]);
    const combined = combineStreams([s1, s2], 'trending');
    await combined(1, signal);
    await combined(2, signal);
    const again = await combined(1, signal);
    expect(ids(again)).toEqual(['a', 'c']);
  });

  it('returns an empty page when every stream has ended', async () => {
    const s1 = stream([[gif('a', 1)]]);
    const s2 = stream([[gif('b', 1)], [gif('c', 1)]]);
    const combined = combineStreams([s1, s2], 'trending');
    await combined(1, signal);
    await combined(2, signal);
    const done = await combined(3, signal);
    expect(done).toEqual({ gifs: [], pages: 2 });
    expect(s1).toHaveBeenCalledTimes(1);
    expect(s2).toHaveBeenCalledTimes(2);
  });

  it('forwards the abort signal to every fetcher', async () => {
    const s1 = stream([[gif('a', 1)]]);
    const s2 = stream([[gif('b', 1)]]);
    const controller = new AbortController();
    await combineStreams([s1, s2], 'trending')(1, controller.signal);
    expect(s1).toHaveBeenCalledWith(1, controller.signal);
    expect(s2).toHaveBeenCalledWith(1, controller.signal);
  });

  it('fetches the streams in parallel', async () => {
    const started: number[] = [];
    const slow = (n: number): FetchStreamPage => async () => {
      started.push(n);
      await new Promise((r) => setTimeout(r, 10));
      return { gifs: [gif(`g${n}`, n)], pages: 1 };
    };
    const promise = combineStreams([slow(1), slow(2), slow(3)], 'trending')(1, signal);
    expect(started).toEqual([1, 2, 3]);
    expect(ids(await promise)).toEqual(['g1', 'g2', 'g3']);
  });
});
