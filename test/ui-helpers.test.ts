import { describe, expect, it } from 'vitest';
import type { Gif } from '../src/api/types';
import type { FillState } from '../src/search/filler';
import { parseQuery } from '../src/search/query';
import { applySuggestion, autocompleteContext, buildSuggestionRows, canReuseSuggestions, filterSuggestions } from '../src/ui/autocomplete';
import { paginatorItems } from '../src/ui/pagination';
import { buildMergeIndex } from '../src/search/merges';
import { aggregateTags, estimateSearchSize, matchRate, needsGroupCounts, pickCountLookups, rankSidebarTags, type TagRow, djb2Hex, fillerId, mergeNote, mergeSignature, pageSortAlias, progressText } from '../src/ui/postsHelpers';

describe('autocompleteContext', () => {
  it('finds the token ending at the caret', () => {
    const ctx = autocompleteContext('blonde big_ti', 13);
    expect(ctx).toEqual({ start: 7, end: 13, prefix: '', fragment: 'big ti' });
  });

  it('remembers - -- ~ prefixes and strips an opening quote', () => {
    expect(autocompleteContext('-bl', 3)?.prefix).toBe('-');
    expect(autocompleteContext('--bl', 4)?.prefix).toBe('--');
    expect(autocompleteContext('~bl', 3)?.prefix).toBe('~');
    const quoted = autocompleteContext('-"big', 5);
    expect(quoted).toMatchObject({ prefix: '-', fragment: 'big' });
  });

  it('needs two non-underscore characters and no colon', () => {
    expect(autocompleteContext('b', 1)).toBeNull();
    expect(autocompleteContext('b__', 3)).toBeNull();
    expect(autocompleteContext('views:5', 7)).toBeNull();
    expect(autocompleteContext('blonde ', 7)).toBeNull();
  });

  it('extends the replaced range to the end of the word after the caret', () => {
    expect(autocompleteContext('blo nde x', 3)?.end).toBe(3);
    expect(autocompleteContext('blonde x', 3)?.end).toBe(6);
  });
});

describe('applySuggestion', () => {
  it('replaces the token, keeps the prefix and puts the caret after the space', () => {
    const text = '-blo x';
    const ctx = autocompleteContext(text, 4)!;
    const result = applySuggestion(text, ctx, 'Blonde Hair');
    expect(result.text).toBe('-blonde_hair x');
    expect(result.caret).toBe('-blonde_hair '.length);
  });

  it('appends a trailing space at the end of the text', () => {
    const ctx = autocompleteContext('a big', 5)!;
    expect(applySuggestion('a big', ctx, 'big tits')).toEqual({ text: 'a big_tits ', caret: 11 });
  });
});

describe('filterSuggestions', () => {
  it('keeps matches, dedupes by key and limits to 10', () => {
    const list = [
      { text: 'Big Tits', count: 1 },
      { text: 'big_tits', count: 2 },
      { text: 'Other', count: 3 },
      ...Array.from({ length: 20 }, (_, i) => ({ text: `big ${i}`, count: i })),
    ];
    const out = filterSuggestions(list, 'big');
    expect(out).toHaveLength(10);
    expect(out[0].text).toBe('Big Tits');
    expect(out.some((s) => s.text === 'Other')).toBe(false);
    expect(out.filter((s) => s.text.toLowerCase().replace(/_/g, ' ') === 'big tits')).toHaveLength(1);
  });
});

describe('paginatorItems', () => {
  it('shows everything for a small known range', () => {
    expect(paginatorItems(1, 3, 3)).toEqual([1, 2, 3]);
  });

  it('uses gaps around the window when the last page is known', () => {
    expect(paginatorItems(10, 10, 20)).toEqual([1, 'gap', 8, 9, 10, 11, 12, 'gap', 20]);
  });

  it('has no gap when the window touches the ends', () => {
    expect(paginatorItems(3, 5, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('ends with a "more" marker when the end is unknown', () => {
    expect(paginatorItems(1, 2, null)).toEqual([1, 2, 'more']);
    expect(paginatorItems(5, 5, null)).toEqual([1, 'gap', 3, 4, 5, 'more']);
  });

  it('includes the furthest known page when it is beyond the window', () => {
    expect(paginatorItems(2, 9, null)).toEqual([1, 2, 3, 4, 'gap', 9, 'more']);
  });

  it('never links past the known pages when the end is unknown', () => {
    expect(paginatorItems(4, 4, null)).toEqual([1, 2, 3, 4, 'more']);
  });
});

const gif = (id: string, tags: string[]): Gif => ({
  id, userName: 'u', createDate: 0, views: 1, likes: 0, duration: 1, width: 1, height: 1,
  hasAudio: false, type: 1, tags, niches: [], description: null, verified: false, urls: {},
});

describe('aggregateTags', () => {
  it('counts posts per tag, sorts by count then name and keeps first casing', () => {
    const rows = aggregateTags([
      gif('1', ['Big Tits', 'blonde', 'blonde']),
      gif('2', ['big tits', 'Anal']),
      gif('3', ['Zed']),
    ]);
    expect(rows).toEqual([
      { key: 'big tits', term: 'big_tits', name: 'Big Tits', pageCount: 2 },
      { key: 'anal', term: 'anal', name: 'Anal', pageCount: 1 },
      { key: 'blonde', term: 'blonde', name: 'blonde', pageCount: 1 },
      { key: 'zed', term: 'zed', name: 'Zed', pageCount: 1 },
    ]);
  });

  it('limits to the top N', () => {
    const tags = Array.from({ length: 50 }, (_, i) => `t${String(i).padStart(2, '0')}`);
    expect(aggregateTags([gif('1', tags)], 30)).toHaveLength(30);
  });
});

describe('filler id helpers', () => {
  it('sorts rule keys', () => {
    expect(fillerId('q', 'g', 75, ['b', 'a'])).toBe('q|g|75|bl:a,b');
  });

  it('hashes deterministically to short hex', () => {
    expect(djb2Hex('abc')).toBe(djb2Hex('abc'));
    expect(djb2Hex('abc')).not.toBe(djb2Hex('abd'));
    expect(djb2Hex('abc')).toMatch(/^[0-9a-f]{1,8}$/);
  });
});

describe('pageSortAlias', () => {
  it('returns the order token used by the query text', () => {
    const q = parseQuery('foo order:views');
    expect(pageSortAlias(q, q.pageSort!)).toBe('order:views');
  });
});

const state = (patch: Partial<FillState>): FillState => ({
  page: 1, posts: [], pageSize: 75, phase: 'filling', serverPagesScanned: 0, rejected: {},
  endReached: false, lastPage: null, knownPages: 1, ...patch,
});

describe('progressText', () => {
  it('describes filling', () => {
    expect(progressText(state({ posts: new Array(38).fill(gif('x', [])), serverPagesScanned: 4 })))
      .toBe('Searching… 38 / 75 · 4 server pages scanned');
  });

  it('describes seeking', () => {
    expect(progressText(state({ page: 5, phase: 'seeking', seekingPage: 3 })))
      .toBe('Finding where page 5 starts… (filling page 3)');
  });

  it('describes a paused fill, also while still seeking', () => {
    expect(progressText(state({ phase: 'paused', serverPagesScanned: 20, posts: new Array(38).fill(gif('x', [])) })))
      .toBe('Scanned 20 server pages (≈2,000 posts) and found 38 matches so far.');
    expect(progressText(state({ page: 5, phase: 'paused', serverPagesScanned: 20, knownPages: 3 })))
      .toContain('Still looking for where page 5 starts');
  });

  it('says when nothing matched and is silent when done with posts', () => {
    expect(progressText(state({ phase: 'done' }))).toBe('No posts matched your search.');
    expect(progressText(state({ phase: 'done', posts: [gif('x', [])] }))).toBeNull();
  });

  it('shows errors', () => {
    expect(progressText(state({ phase: 'error', error: new Error('boom') }))).toBe('boom');
  });
});

describe('rankSidebarTags', () => {
  const tag = (name: string, pageCount: number): TagRow => ({ key: name.toLowerCase(), term: name.toLowerCase().replace(/ /g, '_'), name, pageCount });
  const base = {
    tags: [tag('Pussy', 5), tag('Anal', 4), tag('Blonde', 9), tag('Rare', 1)],
    canonical: (k: string) => k,
    globalCount: () => undefined as number | null | undefined,
    base: undefined as number | undefined,
    postsOnPage: 10,
  };

  it('without a query shows global counts, sorted by page frequency, with loading and missing rows', () => {
    const g: Record<string, number | null | undefined> = { pussy: 3400, anal: 900, blonde: 1400, rare: null };
    const rows = rankSidebarTags({ ...base, required: [], globalCount: (k) => g[k] });
    expect(rows.map((r) => [r.key, r.count, r.estimated])).toEqual([
      ['blonde', 1400, false], ['pussy', 3400, false], ['anal', 900, false], ['rare', undefined, false],
    ]);
    expect(rows[3].missing).toBe(true);
    g.anal = undefined;
    const loading = rankSidebarTags({ ...base, required: [], globalCount: (k) => g[k] });
    expect(loading.find((r) => r.key === 'anal')).toMatchObject({ count: undefined, missing: false });
  });

  it('with a query estimates base * share and caps required rows at the base', () => {
    const rows = rankSidebarTags({ ...base, required: ['blonde'], base: 1000, postsOnPage: 10, globalCount: () => 99 });
    expect(rows.map((r) => [r.key, r.count, r.percent, r.inQuery, r.estimated])).toEqual([
      ['blonde', 1000, 100, true, true],
      ['pussy', 500, 50, false, true],
      ['anal', 400, 40, false, true],
      ['rare', 100, 10, false, true],
    ]);
  });

  it('shows unknown estimates while the base is unknown', () => {
    const rows = rankSidebarTags({ ...base, required: ['blonde'] });
    expect(rows.every((r) => r.count === undefined)).toBe(true);
    expect(rows.find((r) => r.key === 'pussy')!.percent).toBe(50);
  });

  it('limits to the top tags by page count but always keeps required tags', () => {
    const rows = rankSidebarTags({
      ...base, required: ['rare'], limit: 2, base: 10,
      tags: [tag('Pussy', 5), tag('Anal', 4), tag('Blonde', 3), tag('Rare', 1)],
    });
    expect(rows.map((r) => r.key)).toEqual(['pussy', 'anal', 'rare']);
  });

  it('breaks ties by term and displays the key with spaces', () => {
    const rows = rankSidebarTags({
      ...base, required: [], tags: [tag('Bb', 1), tag('Aa', 1), tag('Cc', 3), tag('Big Tits', 2)], globalCount: () => 7,
    });
    expect(rows.map((r) => r.key)).toEqual(['cc', 'big tits', 'aa', 'bb']);
    const big = rows.find((r) => r.key === 'big tits')!;
    expect(big.label).toBe('big tits');
    expect(big.term).toBe('big_tits');
  });
});

describe('estimateSearchSize', () => {
  const index = buildMergeIndex([['big tits', 'big boobs']], []);
  const g: Record<string, number | null | undefined> = { 'big tits': 900, 'big boobs': 100, blonde: 5000, anal: 300 };
  const globalCount = (k: string) => g[k];
  const args = {
    index, globalCount, streamTotals: [undefined] as (number | undefined)[], rate: undefined as number | undefined, settled: false,
  };

  it('uses the group global count for one required group', () => {
    expect(estimateSearchSize({ ...args, required: ['big tits'] })).toBe(1000);
    expect(estimateSearchSize({ ...args, required: ['blonde'] })).toBe(5000);
    expect(estimateSearchSize({ ...args, required: ['big tits'], globalCount: (k) => (k === 'big boobs' ? undefined : g[k]) })).toBeUndefined();
  });

  it('multiplies the totals by the match rate when no stream hit the cap', () => {
    expect(estimateSearchSize({ ...args, required: ['blonde', 'anal'], streamTotals: [4000, 1000], rate: 0.25 })).toBe(1250);
    expect(estimateSearchSize({ ...args, required: ['blonde', 'anal'], streamTotals: [4000], rate: undefined })).toBeUndefined();
    expect(estimateSearchSize({ ...args, required: ['blonde', 'anal'], streamTotals: [4000, undefined], rate: 0.5 })).toBeUndefined();
  });

  it('falls back to the smallest required group when a stream hit 10000', () => {
    expect(estimateSearchSize({ ...args, required: ['blonde', 'anal'], streamTotals: [10000], rate: 0.5 })).toBe(300);
    expect(estimateSearchSize({ ...args, required: ['blonde', 'anal'], streamTotals: [10000], globalCount: (k) => (k === 'anal' ? undefined : g[k]) })).toBeUndefined();
  });

  it('falls back to the smallest required group when totals stay unknown after the fill is done', () => {
    expect(estimateSearchSize({ ...args, required: ['blonde', 'anal'], streamTotals: [undefined], settled: true })).toBe(300);
    expect(estimateSearchSize({ ...args, required: ['blonde', 'anal'], streamTotals: [4000, undefined], rate: 0.5, settled: true })).toBe(300);
    expect(estimateSearchSize({ ...args, required: ['blonde', 'anal'], streamTotals: [undefined], settled: true, globalCount: (k) => (k === 'anal' ? undefined : g[k]) })).toBeUndefined();
  });

  it('stays unknown while the page is still filling and a total is missing', () => {
    expect(estimateSearchSize({ ...args, required: ['blonde', 'anal'], streamTotals: [undefined], settled: false })).toBeUndefined();
    expect(estimateSearchSize({ ...args, required: ['blonde', 'anal'], streamTotals: [4000, undefined], rate: 0.5, settled: false })).toBeUndefined();
  });

  it('needsGroupCounts only when the estimate uses them', () => {
    expect(needsGroupCounts([], [], false)).toBe(false);
    expect(needsGroupCounts(['a'], [undefined], false)).toBe(true);
    expect(needsGroupCounts(['a', 'b'], [500], false)).toBe(false);
    expect(needsGroupCounts(['a', 'b'], [10000], false)).toBe(true);
  });

  it('needsGroupCounts is true for unknown totals only once the fill is done', () => {
    expect(needsGroupCounts(['a', 'b'], [undefined], false)).toBe(false);
    expect(needsGroupCounts(['a', 'b'], [undefined], true)).toBe(true);
    expect(needsGroupCounts(['a', 'b'], [500, undefined], true)).toBe(true);
    expect(needsGroupCounts(['a', 'b'], [500], true)).toBe(false);
  });

  it('matchRate is kept over kept plus rejected', () => {
    expect(matchRate({ posts: [1, 2] as never, rejected: { blacklist: 1, tags: 5 } })).toBe(0.25);
    expect(matchRate({ posts: [], rejected: {} })).toBeUndefined();
  });
});

describe('merges in the sidebar', () => {
  const index = buildMergeIndex([['big tits', 'big boobs']], []);
  const tag = (name: string, pageCount: number): TagRow => ({ key: name.toLowerCase(), term: name.toLowerCase().replace(/ /g, '_'), name, pageCount });
  const gifWith = (id: string, tags: string[]): Gif => ({
    id, userName: 'u', createDate: 0, views: 1, likes: 0, duration: 1, width: 1, height: 1,
    hasAudio: false, type: 1, tags, niches: [], description: null, verified: false, urls: {},
  });

  it('aggregateTags counts group members as the canonical key once per post', () => {
    const rows = aggregateTags([
      gifWith('1', ['Big Boobs', 'Big Tits']),
      gifWith('2', ['Big Boobs']),
      gifWith('3', ['Big Tits']),
    ], 30, index);
    expect(rows).toEqual([{ key: 'big tits', term: 'big_tits', name: 'Big Tits', pageCount: 3 }]);
    const onlyMember = aggregateTags([gifWith('1', ['Big Boobs'])], 30, index);
    expect(onlyMember).toEqual([{ key: 'big tits', term: 'big_tits', name: 'big tits', pageCount: 1 }]);
  });

  it('without a query adds up the global counts of the members', () => {
    const g: Record<string, number | null | undefined> = { 'big tits': 900, 'big boobs': 100, anal: 50 };
    const args = {
      tags: [tag('big tits', 3), tag('Anal', 1)], required: [] as string[], index,
      canonical: (k: string) => k, base: undefined, postsOnPage: 4,
    };
    const rows = rankSidebarTags({ ...args, globalCount: (k) => g[k] });
    expect(rows.map((r) => [r.key, r.count])).toEqual([['big tits', 1000], ['anal', 50]]);
    g['big boobs'] = undefined; // still loading: the group is not known yet
    const loading = rankSidebarTags({ ...args, globalCount: (k) => g[k] });
    expect(loading.find((r) => r.key === 'big tits')!.count).toBeUndefined();
    g['big boobs'] = null; // no such tag: counts as zero
    const nul = rankSidebarTags({ ...args, globalCount: (k) => g[k] });
    expect(nul.find((r) => r.key === 'big tits')!.count).toBe(900);
  });

  it('mergeSignature and mergeNote describe the groups that affect a query', () => {
    expect(mergeSignature(parseQuery('big_tits blonde'), index)).toBe('big tits+big boobs');
    expect(mergeSignature(parseQuery('blonde'), index)).toBe('');
    expect(fillerId('q', 'g', 75, [], '')).toBe('q|g|75|bl:');
    expect(fillerId('q', 'g', 75, [], 'x')).toBe('q|g|75|bl:|mg:x');
    expect(mergeNote([{ from: 'big boobs', to: 'big tits' }], index)).toBe('Searching big_tits (with big_boobs) for big_boobs.');
    expect(mergeNote([], index)).toBeNull();
  });
});

describe('buildSuggestionRows', () => {
  const aliasMap = new Map([['blond', 'blonde'], ['blondee', 'blond'], ['bigboobs', 'big boobs']]);
  const mergeIndex = buildMergeIndex([['big tits', 'big boobs']], []);

  it('shows alias sources as redirects to the resolved canonical, with the group count', () => {
    const rows = buildSuggestionRows({
      fragment: 'blond',
      apiSuggestions: [{ text: 'blonde', count: 500 }],
      aliasMap,
      mergeIndex,
    });
    expect(rows).toContainEqual({ label: 'blond', target: 'blonde', insert: 'blonde', count: 500 });
    expect(rows.find((r) => r.label === 'blondee')).toBeUndefined();
    expect(rows).toContainEqual({ label: 'blonde', insert: 'blonde', count: 500 });
  });

  it('shows no alias rows for a partial word', () => {
    for (const fragment of ['blo', 'blon']) {
      const rows = buildSuggestionRows({ fragment, apiSuggestions: [{ text: 'blonde', count: 500 }], aliasMap, mergeIndex });
      expect(rows.some((r) => r.target)).toBe(false);
    }
  });

  it('redirects a merged member only when typed completely; the canonical sums the group', () => {
    const rows = buildSuggestionRows({
      fragment: 'big boobs',
      apiSuggestions: [{ text: 'big boobs', count: 40 }, { text: 'big tits', count: 100 }],
      aliasMap: new Map(),
      mergeIndex,
    });
    expect(rows).toEqual([
      { label: 'big_boobs', target: 'big_tits', insert: 'big tits', count: 140 },
      { label: 'big_tits', insert: 'big tits', count: 140 },
    ]);
  });

  it('shows a partly typed merged member as a plain row with its own count', () => {
    const rows = buildSuggestionRows({
      fragment: 'big',
      apiSuggestions: [{ text: 'big boobs', count: 40 }, { text: 'big tits', count: 100 }],
      aliasMap: new Map(),
      mergeIndex,
    });
    expect(rows).toEqual([
      { label: 'big_tits', insert: 'big tits', count: 140 },
      { label: 'big_boobs', insert: 'big boobs', count: 40 },
    ]);
  });

  it('points an alias whose target is a merged member at the canonical', () => {
    const rows = buildSuggestionRows({ fragment: 'bigboobs', apiSuggestions: [], aliasMap, mergeIndex });
    expect(rows).toEqual([{ label: 'bigboobs', target: 'big_tits', insert: 'big tits' }]);
  });

  it('falls back to countOf summed over the target group when the API list lacks it', () => {
    const known: Record<string, number | null> = { 'big tits': 70, 'big boobs': 30, blonde: null };
    const rows = buildSuggestionRows({ fragment: 'bigboobs', apiSuggestions: [], aliasMap, mergeIndex, countOf: (k) => known[k] });
    expect(rows).toEqual([{ label: 'bigboobs', target: 'big_tits', insert: 'big tits', count: 100 }]);
    const unknown = buildSuggestionRows({ fragment: 'blond', apiSuggestions: [], aliasMap, mergeIndex, countOf: (k) => known[k] });
    expect(unknown.find((r) => r.label === 'blond')?.count).toBeUndefined();
  });

  it('sorts prefix matches first, dedupes by label and caps at the limit', () => {
    const rows = buildSuggestionRows({
      fragment: 'tit',
      apiSuggestions: [
        { text: 'big tit', count: 900 },
        { text: 'titan', count: 5 },
        { text: 'Titan', count: 5 },
        { text: 'tits', count: 50 },
      ],
      aliasMap: new Map(),
      mergeIndex: buildMergeIndex([], []),
      limit: 3,
    });
    expect(rows.map((r) => r.label)).toEqual(['tits', 'titan', 'big_tit']);
  });
});

describe('pickCountLookups', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ key: `tag${i}` }));

  it('picks at most 8 unknown rows, in order', () => {
    const picked = pickCountLookups(rows, () => false, new Set());
    expect(picked.map((r) => r.key)).toEqual(rows.slice(0, 8).map((r) => r.key));
  });

  it('skips known rows without using up the cap', () => {
    const known = new Set(['tag0', 'tag1', 'tag2']);
    const picked = pickCountLookups(rows, (key) => known.has(key), new Set());
    expect(picked.map((r) => r.key)).toEqual(['tag3', 'tag4', 'tag5', 'tag6', 'tag7', 'tag8', 'tag9', 'tag10']);
  });

  it('counts rows already chosen for this page against the cap', () => {
    const already = new Set(['tag0', 'tag1', 'tag2', 'tag3', 'tag4', 'tag5', 'tag6']);
    expect(pickCountLookups(rows, () => false, already).map((r) => r.key)).toEqual(['tag7']);
    already.add('tag7');
    expect(pickCountLookups(rows, () => false, already)).toEqual([]);
  });
});

describe('canReuseSuggestions', () => {
  it('reuses a short earlier answer for a longer fragment that extends it', () => {
    expect(canReuseSuggestions('big', 4, 'big t')).toBe(true);
    expect(canReuseSuggestions('big', 0, 'big tits')).toBe(true);
  });
  it('does not reuse a full list (10 or more) or an unknown length', () => {
    expect(canReuseSuggestions('big', 10, 'big t')).toBe(false);
    expect(canReuseSuggestions('big', -1, 'big t')).toBe(false);
  });
  it('does not reuse for the same, shorter or unrelated fragments', () => {
    expect(canReuseSuggestions('big', 3, 'big')).toBe(false);
    expect(canReuseSuggestions('big t', 3, 'big')).toBe(false);
    expect(canReuseSuggestions('big', 3, 'small')).toBe(false);
  });
});
