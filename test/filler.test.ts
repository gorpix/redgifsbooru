import { describe, expect, it } from 'vitest';
import type { Gif } from '../src/api/types';
import { PageFiller, type FillState, type FillerOptions, type StreamPage } from '../src/search/filler';

const SIZE = 100;

interface StreamOptions {
  serverPages?: number; // server pages that have items
  reportedPages?: number; // the `pages` field
  sizes?: Record<number, number>; // items-per-server-page overrides
  idAt?: (sp: number, i: number) => string;
}

// Even index matches; odd index is rejected (index ending in 1 for one reason, the rest for another).
function check(g: Gif): string | null {
  const i = Number(g.id.split('-')[1]);
  if (i % 2 === 0) return null;
  return i % 10 === 1 ? 'tagged' : 'other';
}

function makeStream(opts: StreamOptions = {}) {
  const serverPages = opts.serverPages ?? 7;
  const idAt = opts.idAt ?? ((sp: number, i: number) => `p${sp}-${i}`);
  const itemsOn = (sp: number) => (sp >= 1 && sp <= serverPages ? opts.sizes?.[sp] ?? SIZE : 0);
  const gifAt = (sp: number, i: number) => ({ id: idAt(sp, i) }) as Gif;
  const calls: number[] = [];
  const fetchPage = async (sp: number): Promise<StreamPage> => {
    calls.push(sp);
    return { gifs: Array.from({ length: itemsOn(sp) }, (_, i) => gifAt(sp, i)), pages: opts.reportedPages ?? serverPages };
  };
  // Reference result, computed independently: all matches in order, deduped by id.
  const all: Gif[] = [];
  const seen = new Set<string>();
  for (let sp = 1; sp <= Math.min(serverPages, opts.reportedPages ?? serverPages); sp++) {
    for (let i = 0; i < itemsOn(sp); i++) {
      const g = gifAt(sp, i);
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      if (check(g) === null) all.push(g);
    }
  }
  const expectedPage = (n: number) => all.slice((n - 1) * 75, n * 75).map((g) => g.id);
  return { fetchPage, calls, expectedPage, totalMatches: all.length };
}

type Stream = ReturnType<typeof makeStream>;

const ids = (s: FillState) => s.posts.map((g) => g.id);
const noop = () => {};

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
  };
}

function filler(stream: Stream, extra: Partial<FillerOptions> = {}) {
  return new PageFiller({ key: 'k', fetchPage: stream.fetchPage, check, ...extra });
}

describe('PageFiller', () => {
  it('fills page 1 with exactly the first 75 matches', async () => {
    const s = makeStream();
    const state = await filler(s).fill(1, noop);
    expect(state.phase).toBe('done');
    expect(ids(state)).toEqual(s.expectedPage(1));
    expect(state.posts).toHaveLength(75);
    expect(s.calls).toEqual([1, 2]);
    expect(state.knownPages).toBe(2);
    expect(state.endReached).toBe(false);
    expect(state.lastPage).toBeNull();
  });

  it('starts page 2 right after page 1 without repeating or skipping items', async () => {
    const s = makeStream();
    const f = filler(s);
    const p1 = await f.fill(1, noop);
    const p2 = await f.fill(2, noop);
    expect(ids(p2)).toEqual(s.expectedPage(2));
    expect(ids(p2)).not.toContain(ids(p1)[74]);
    // Page 1's 75th match is inside server page 2, so page 2 resumes there (page 1 is not refetched).
    expect(s.calls).toEqual([1, 2, 2, 3]);
  });

  it('jumping to page 3 seeks pages 1-2 first and matches sequential filling', async () => {
    const s = makeStream();
    const updates: FillState[] = [];
    const jumped = await filler(s).fill(3, (u) => updates.push(u));
    expect(jumped.phase).toBe('done');
    expect(ids(jumped)).toEqual(s.expectedPage(3));
    const seeking = updates.filter((u) => u.phase === 'seeking');
    expect(seeking.length).toBeGreaterThan(0);
    expect(seeking.every((u) => u.page === 3 && u.posts.length === 0)).toBe(true);
    expect(new Set(seeking.map((u) => u.seekingPage))).toEqual(new Set([1, 2]));
    expect(updates.some((u) => u.phase === 'filling' && u.page === 3)).toBe(true);
    expect(jumped.knownPages).toBeGreaterThanOrEqual(3);

    const s2 = makeStream();
    const f2 = filler(s2);
    await f2.fill(1, noop);
    await f2.fill(2, noop);
    expect(ids(await f2.fill(3, noop))).toEqual(ids(jumped));
  });

  it('does not treat short server pages as the end', async () => {
    const s = makeStream({ sizes: { 1: 86, 2: 86, 3: 86 } });
    const f = filler(s);
    const p1 = await f.fill(1, noop);
    expect(p1.endReached).toBe(false);
    expect(ids(p1)).toEqual(s.expectedPage(1));
    expect(ids(await f.fill(2, noop))).toEqual(s.expectedPage(2));
  });

  it('ends on an empty page: lastPage and endReached', async () => {
    const s = makeStream({ reportedPages: 99 });
    const state = await filler(s).fill(5, noop);
    expect(s.totalMatches).toBe(350);
    expect(ids(state)).toEqual(s.expectedPage(5));
    expect(state.posts).toHaveLength(50);
    expect(state.endReached).toBe(true);
    expect(state.lastPage).toBe(5);
    expect(state.phase).toBe('done');
  });

  it('ends when serverPage exceeds `pages` without fetching beyond it', async () => {
    const s = makeStream({ serverPages: 10, reportedPages: 7 });
    const state = await filler(s).fill(5, noop);
    expect(state.lastPage).toBe(5);
    expect(Math.max(...s.calls)).toBe(7);
    expect(ids(state)).toEqual(s.expectedPage(5));
  });

  it('resolves a page beyond lastPage as done and empty, without fetching', async () => {
    const s = makeStream();
    const f = filler(s);
    await f.fill(5, noop);
    const before = s.calls.length;
    const state = await f.fill(9, noop);
    expect(state.phase).toBe('done');
    expect(state.posts).toEqual([]);
    expect(state.lastPage).toBe(5);
    expect(s.calls.length).toBe(before);
  });

  it('discovers the end when asked for a page past it', async () => {
    const state = await filler(makeStream()).fill(9, noop);
    expect(state.posts).toEqual([]);
    expect(state.phase).toBe('done');
    expect(state.endReached).toBe(true);
    expect(state.lastPage).toBe(5);
  });

  it('a stream with no matches at all is one empty page', async () => {
    const f = new PageFiller({ key: 'k', fetchPage: makeStream().fetchPage, check: () => 'no' });
    const state = await f.fill(1, noop);
    expect(state.posts).toEqual([]);
    expect(state.endReached).toBe(true);
    expect(state.lastPage).toBe(1);
    expect(state.rejected).toEqual({ no: 700 });
  });

  it('stops at maxServerPage', async () => {
    const s = makeStream();
    const f = filler(s, { maxServerPage: 3 });
    expect(ids(await f.fill(2, noop))).toEqual(s.expectedPage(2));
    const p3 = await f.fill(3, noop);
    expect(p3.posts).toEqual([]);
    expect(p3.endReached).toBe(true);
    expect(p3.lastPage).toBe(2);
    expect(Math.max(...s.calls)).toBe(3);
  });

  it('skips duplicate ids across server pages (neither match nor rejection)', async () => {
    // Server page 3 repeats the first 20 items of page 2.
    const idAt = (sp: number, i: number) => (sp === 3 && i < 20 ? `p2-${i}` : `p${sp}-${i}`);
    const s = makeStream({ idAt });
    expect(s.totalMatches).toBe(340); // 700 items - 20 duplicates, half match
    const f = filler(s);
    const p2 = await f.fill(2, noop);
    expect(ids(p2)).toEqual(s.expectedPage(2));
    expect(new Set(ids(p2)).size).toBe(75);
    expect(ids(await f.fill(1, noop))).toEqual(s.expectedPage(1)); // rescan stays consistent
    expect(ids(await f.fill(3, noop))).toEqual(s.expectedPage(3));
    const p5 = await filler(s).fill(5, noop);
    expect(ids(p5)).toEqual(s.expectedPage(5));
    expect(p5.posts).toHaveLength(40);
    expect(p5.lastPage).toBe(5);
  });

  it('pauses after maxServerPagesPerRun and resumes to the same result', async () => {
    const ref = makeStream();
    const expected = ids(await filler(ref).fill(3, noop));

    const s = makeStream();
    const f = filler(s, { maxServerPagesPerRun: 2 });
    let state = await f.fill(3, noop);
    let runs = 1;
    expect(state.phase).toBe('paused');
    expect(state.serverPagesScanned).toBe(2);
    expect(s.calls).toEqual([1, 2]);
    while (state.phase === 'paused') {
      const before = s.calls.length;
      state = await f.fill(3, noop);
      expect(s.calls.length - before).toBeLessThanOrEqual(2);
      runs++;
    }
    expect(runs).toBeGreaterThan(2);
    expect(state.phase).toBe('done');
    expect(ids(state)).toEqual(expected);
    // Only the server page shared between two booru pages is fetched twice.
    expect(new Set(s.calls)).toEqual(new Set(ref.calls));
  });

  it('keeps partial matches when paused while filling the requested page', async () => {
    const s = makeStream();
    const f = filler(s, { maxServerPagesPerRun: 1 });
    const state = await f.fill(1, noop);
    expect(state.phase).toBe('paused');
    expect(state.posts).toHaveLength(50);
    expect(ids(state)).toEqual(s.expectedPage(1).slice(0, 50));
    expect(ids(await f.fill(1, noop))).toEqual(s.expectedPage(1));
    expect(s.calls).toEqual([1, 2]);
  });

  it('a different page after a pause still gives correct results', async () => {
    const s = makeStream();
    const f = filler(s, { maxServerPagesPerRun: 2 });
    expect((await f.fill(3, noop)).phase).toBe('paused');
    let state = await f.fill(1, noop); // discards partial progress for page 2
    expect(ids(state)).toEqual(s.expectedPage(1));
    state = await f.fill(2, noop);
    while (state.phase === 'paused') state = await f.fill(2, noop);
    expect(ids(state)).toEqual(s.expectedPage(2));
  });

  it('rejects with AbortError on abort and a later fill resumes', async () => {
    const s = makeStream();
    const ac = new AbortController();
    const f = new PageFiller({
      key: 'k',
      check,
      fetchPage: async (sp) => {
        const res = await s.fetchPage(sp);
        if (sp === 2) ac.abort();
        return res;
      },
    });
    const err = await f.fill(3, noop, ac.signal).then(() => null, (e: unknown) => e);
    expect((err as DOMException).name).toBe('AbortError');
    const state = await f.fill(3, noop);
    expect(state.phase).toBe('done');
    expect(ids(state)).toEqual(s.expectedPage(3));

    // An already-aborted signal never fetches and rejects with its reason.
    const before = s.calls.length;
    const pre = new AbortController();
    pre.abort(new Error('stop'));
    await expect(filler(s).fill(1, noop, pre.signal)).rejects.toThrow('stop');
    expect(s.calls.length).toBe(before);
  });

  it('emits phase error on fetch failure, rejects, and retries from the saved cursor', async () => {
    const s = makeStream();
    let failOnce = true;
    const boom = new Error('boom');
    const f = new PageFiller({
      key: 'k',
      check,
      fetchPage: async (sp) => {
        if (sp === 2 && failOnce) { failOnce = false; throw boom; }
        return s.fetchPage(sp);
      },
    });
    const updates: FillState[] = [];
    await expect(f.fill(1, (u) => updates.push(u))).rejects.toBe(boom);
    const last = updates[updates.length - 1];
    expect(last.phase).toBe('error');
    expect(last.error).toBe(boom);
    expect(last.posts).toHaveLength(50); // progress from server page 1 kept
    const state = await f.fill(1, noop);
    expect(ids(state)).toEqual(s.expectedPage(1));
    expect(s.calls).toEqual([1, 2]); // server page 1 not refetched
  });

  it('tallies rejection reasons for the filled page only', async () => {
    const s = makeStream();
    // Page 1 scans server page 1 fully and items 0..48 of server page 2 (25 matches).
    const p1 = await filler(s).fill(1, noop);
    expect(p1.rejected).toEqual({ tagged: 10 + 5, other: 40 + 19 });
    // Page 3 after seeking: tallies cover page 3's own scan (75 matches = 75 rejects), not pages 1-2.
    const p3 = await filler(s).fill(3, noop);
    expect(Object.values(p3.rejected).reduce((a, b) => a + b, 0)).toBe(75);
  });

  it('onUpdate receives fresh objects each time', async () => {
    const s = makeStream();
    const updates: FillState[] = [];
    await filler(s).fill(2, (u) => updates.push(u));
    expect(updates.length).toBeGreaterThan(2);
    expect(new Set(updates).size).toBe(updates.length);
    expect(new Set(updates.map((u) => u.posts)).size).toBe(updates.length);
    expect(new Set(updates.map((u) => u.rejected)).size).toBe(updates.length);
    // earlier snapshots are not mutated by later progress
    const filling = updates.filter((u) => u.phase === 'filling');
    expect(filling.length).toBeGreaterThan(0);
    expect(filling[0].posts.length).toBeLessThan(75);
    expect(updates[updates.length - 1].phase).toBe('done');
  });

  describe('persistence', () => {
    it('round trips page starts: a new instance fills page 2 without fetching page 1', async () => {
      const storage = memoryStorage();
      await filler(makeStream(), { storage, now: () => 1000 }).fill(2, noop);
      expect(JSON.parse(storage.data.get('rgb:cursor:k')!)).toMatchObject({ at: 1000, lastPage: null });

      const b = makeStream();
      const state = await filler(b, { storage, now: () => 1000 + 29 * 60_000 }).fill(2, noop);
      expect(ids(state)).toEqual(b.expectedPage(2));
      expect(b.calls[0]).toBe(2);
      expect(b.calls).not.toContain(1);
    });

    it('persists end info', async () => {
      const storage = memoryStorage();
      await filler(makeStream(), { storage }).fill(7, noop);
      const b = makeStream();
      const state = await filler(b, { storage }).fill(9, noop);
      expect(state.lastPage).toBe(5);
      expect(b.calls).toEqual([]);
    });

    it('ignores records older than 30 minutes', async () => {
      const storage = memoryStorage();
      await filler(makeStream(), { storage, now: () => 0 }).fill(2, noop);
      const b = makeStream();
      const state = await filler(b, { storage, now: () => 30 * 60_000 }).fill(2, noop);
      expect(ids(state)).toEqual(b.expectedPage(2));
      expect(b.calls[0]).toBe(1);
    });

    it('ignores malformed records', async () => {
      const bad = ['nope', '{}', '{"at":1,"starts":[{"serverPage":2,"index":0}],"lastPage":null}', '{"at":1,"starts":[],"lastPage":null}'];
      for (const raw of bad) {
        const storage = memoryStorage();
        storage.data.set('rgb:cursor:k', raw);
        const b = makeStream();
        const state = await filler(b, { storage, now: () => 2 }).fill(1, noop);
        expect(ids(state)).toEqual(b.expectedPage(1));
        expect(b.calls[0]).toBe(1);
      }
    });
  });
});
