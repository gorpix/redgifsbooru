import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TagCounts, TAG_COUNTS_KEY } from '../src/api/tagCounts';

const DAY = 24 * 60 * 60 * 1000;

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
  };
}

type Suggest = (fragment: string, opts?: { priority?: 'high' | 'low' }) => Promise<{ text: string; count: number }[]>;

function setup(suggest: Suggest, storage: ReturnType<typeof fakeStorage> | null = fakeStorage(), now = { t: 1_000_000_000 }) {
  const api = { suggestTags: vi.fn(suggest) };
  const counts = new TagCounts(api, storage, () => now.t);
  return { api, counts, storage, now };
}

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('TagCounts lookups', () => {
  const suggestions = [
    { text: 'Big Tits', count: 100 },
    { text: 'Big Tits Milf', count: 5 },
    { text: 'Big Tits Teen', count: 4 },
    { text: 'Big Tits Anal', count: 3 },
    { text: 'Big Tits Pov', count: 2 },
  ];

  it('stores the exact-match count and the first four suggestions, at low priority', async () => {
    const { api, counts } = setup(async () => suggestions);
    expect(counts.get('big_tits')).toBeUndefined();
    counts.request(['Big_Tits']);
    await flush();
    expect(api.suggestTags).toHaveBeenCalledWith('big tits', { priority: 'low' });
    expect(counts.get('big tits')).toBe(100);
    expect(counts.get('BIG_TITS')).toBe(100);
    expect(counts.similar('big tits')).toEqual(['Big Tits', 'Big Tits Milf', 'Big Tits Teen', 'Big Tits Anal']);
  });

  it('is null when no suggestion matches exactly', async () => {
    const { counts } = setup(async () => [{ text: 'Bigger', count: 9 }]);
    counts.request(['big']);
    await flush();
    expect(counts.get('big')).toBeNull();
    expect(counts.similar('big')).toEqual(['Bigger']);
  });

  it('skips known and pending names, and deduplicates by key', async () => {
    const { api, counts } = setup(async () => suggestions);
    counts.request(['big tits', 'Big_Tits', 'big  tits']);
    counts.request(['big tits']);
    await flush();
    counts.request(['big tits']);
    await flush();
    expect(api.suggestTags).toHaveBeenCalledTimes(1);
  });

  it('runs at most two lookups at a time', async () => {
    const releases: Array<() => void> = [];
    let running = 0;
    let peak = 0;
    const { api, counts } = setup(() => new Promise((resolve) => {
      running++;
      peak = Math.max(peak, running);
      releases.push(() => { running--; resolve([]); });
    }));
    counts.request(['a', 'b', 'c', 'd']);
    await flush();
    expect(api.suggestTags).toHaveBeenCalledTimes(2);
    releases.shift()!();
    await flush();
    expect(api.suggestTags).toHaveBeenCalledTimes(3);
    while (releases.length || api.suggestTags.mock.calls.length < 4) {
      releases.shift()?.();
      await flush();
    }
    expect(peak).toBe(2);
    expect(counts.get('d')).toBeNull();
  });

  it('notifies subscribers after each result and stops after unsubscribe', async () => {
    const { counts } = setup(async () => []);
    const listener = vi.fn();
    const off = counts.subscribe(listener);
    counts.request(['a', 'b']);
    await flush();
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    counts.request(['c']);
    await flush();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('TagCounts failures', () => {
  it('does not persist a failed lookup and retries after 5 minutes', async () => {
    let fail = true;
    const { api, counts, storage, now } = setup(async () => {
      if (fail) throw new Error('net');
      return [{ text: 'Tag', count: 7 }];
    });
    counts.request(['tag']);
    await flush();
    expect(counts.get('tag')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(storage!.data.has(TAG_COUNTS_KEY)).toBe(false);

    now.t += 4 * 60 * 1000;
    counts.request(['tag']);
    await flush();
    expect(api.suggestTags).toHaveBeenCalledTimes(1);

    fail = false;
    now.t += 2 * 60 * 1000;
    counts.request(['tag']);
    await flush();
    expect(api.suggestTags).toHaveBeenCalledTimes(2);
    expect(counts.get('tag')).toBe(7);
  });
});

describe('TagCounts persistence', () => {
  it('saves debounced by 500 ms in the RedGIFS-X format', async () => {
    const { counts, storage, now } = setup(async (f) => [{ text: f, count: 3 }]);
    counts.request(['a']);
    await flush();
    counts.request(['b']);
    await flush();
    expect(storage!.data.has(TAG_COUNTS_KEY)).toBe(false);
    await vi.advanceTimersByTimeAsync(499);
    expect(storage!.data.has(TAG_COUNTS_KEY)).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(JSON.parse(storage!.data.get(TAG_COUNTS_KEY)!)).toEqual({
      a: [3, now.t, ['a']],
      b: [3, now.t, ['b']],
    });
  });

  it('loads from storage, drops entries older than 3 days, tolerates garbage', () => {
    const now = { t: 10 * DAY };
    const storage = fakeStorage({
      [TAG_COUNTS_KEY]: JSON.stringify({
        fresh: [5, now.t - DAY, ['x']],
        stale: [6, now.t - 3 * DAY - 1, []],
        none: [null, now.t - 1000, []],
        bad1: 'oops',
        bad2: [1],
        bad3: ['x', now.t, []],
      }),
    });
    const { counts } = setup(async () => [], storage, now);
    expect(counts.get('fresh')).toBe(5);
    expect(counts.similar('fresh')).toEqual(['x']);
    expect(counts.get('stale')).toBeUndefined();
    expect(counts.get('none')).toBeNull();
    expect(counts.get('bad1')).toBeUndefined();
    expect(counts.get('bad3')).toBeUndefined();
    expect(() => setup(async () => [], fakeStorage({ [TAG_COUNTS_KEY]: '{not json' }))).not.toThrow();
  });

  it('keeps the newest 5000 entries on save', async () => {
    const now = { t: 1_000_000_000 };
    const entries: Record<string, unknown> = {};
    for (let i = 0; i < 5100; i++) entries[`tag${i}`] = [i, now.t - 100_000 + i, []];
    const storage = fakeStorage({ [TAG_COUNTS_KEY]: JSON.stringify(entries) });
    const { counts } = setup(async () => [], storage, now);
    counts.merge({ extra: [1, now.t, []] });
    await vi.advanceTimersByTimeAsync(600);
    const saved = JSON.parse(storage.data.get(TAG_COUNTS_KEY)!);
    expect(Object.keys(saved)).toHaveLength(5000);
    expect(saved.extra).toBeDefined();
    expect(saved.tag5099).toBeDefined();
    expect(saved.tag0).toBeUndefined();
    expect(saved.tag100).toBeUndefined();
    expect(saved.tag101).toBeDefined();
  });

  it('works without storage', async () => {
    const { counts } = setup(async () => [{ text: 'a', count: 1 }], null);
    counts.request(['a']);
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(counts.get('a')).toBe(1);
  });
});

describe('TagCounts.merge', () => {
  it('lets the newer entry win and notifies only on change', async () => {
    const now = { t: 1_000_000_000 };
    const storage = fakeStorage({ [TAG_COUNTS_KEY]: JSON.stringify({ a: [1, now.t - 2000, ['old']] }) });
    const { counts } = setup(async () => [], storage, now);
    const listener = vi.fn();
    counts.subscribe(listener);
    counts.merge({ a: [2, now.t - 1000, ['new']], b: [3, now.t - 5000, []] });
    expect(counts.get('a')).toBe(2);
    expect(counts.similar('a')).toEqual(['new']);
    expect(counts.get('b')).toBe(3);
    expect(listener).toHaveBeenCalledTimes(1);
    counts.merge({ a: [9, now.t - 3000, []] }); // older: ignored
    expect(counts.get('a')).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);
    counts.merge({ 'Big_Tits': [4, now.t, []], stale: [1, now.t - 4 * DAY, []] });
    expect(counts.get('big tits')).toBe(4);
    expect(counts.get('stale')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(600);
    expect(JSON.parse(storage.data.get(TAG_COUNTS_KEY)!).a[0]).toBe(2);
  });
});
