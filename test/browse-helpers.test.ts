import { describe, expect, it } from 'vitest';
import { aliasesPointingTo, hasCategoryOverride, popularTags, POPULAR_ORDER, poolsPaging, postsWithTag, safeLink, setCategoryOverride } from '../src/ui/browseHelpers';
import { fillerId, hasFilters, rankSidebarTags, scopedBaseSize, sourceKey } from '../src/ui/postsHelpers';
import { pipelineFillerId, userStreamOrder } from '../src/ui/searchPipeline';
import { buildMergeIndex } from '../src/search/merges';
import { parseQuery } from '../src/search/query';
import { parseCategoryText } from '../src/search/categories';
import type { TagRow } from '../src/ui/postsHelpers';

describe('popular scale mapping', () => {
  it('maps day to trending, week to top7, month to top28', () => {
    expect(POPULAR_ORDER).toEqual({ day: 'trending', week: 'top7', month: 'top28' });
  });
  it('builds the search text of each tab (trending is the default order, so empty)', () => {
    expect(popularTags('day')).toBe('');
    expect(popularTags('week')).toBe('order:top7');
    expect(popularTags('month')).toBe('order:top28');
  });
  it('the search text parses back to the server order', () => {
    expect(parseQuery(popularTags('week')).serverOrder).toBe('top7');
    expect(parseQuery(popularTags('month')).serverOrder).toBe('top28');
    expect(parseQuery(popularTags('day')).serverOrder).toBe('trending');
  });
});

describe('poolsPaging', () => {
  it('clamps the page and finds neighbours', () => {
    expect(poolsPaging(1, 37)).toEqual({ page: 1, pages: 37, prev: null, next: 2 });
    expect(poolsPaging(37, 37)).toEqual({ page: 37, pages: 37, prev: 36, next: null });
    expect(poolsPaging(99, 37)).toMatchObject({ page: 37, next: null });
  });
  it('handles an unknown page count and bad input', () => {
    expect(poolsPaging(3, 0)).toEqual({ page: 3, pages: 0, prev: 2, next: null });
    expect(poolsPaging(0, 5)).toMatchObject({ page: 1 });
    expect(poolsPaging(NaN, NaN)).toEqual({ page: 1, pages: 0, prev: null, next: null });
  });
});

describe('source-aware filler ids', () => {
  it('sourceKey is empty for the global search and stable for the others', () => {
    expect(sourceKey({ kind: 'search' })).toBe('');
    expect(sourceKey({ kind: 'user', name: ' Bob ' })).toBe('user:bob');
    expect(sourceKey({ kind: 'niche', id: 'Pale-Girls' })).toBe('niche:pale-girls');
  });
  it('leaves search ids unchanged and appends the source otherwise', () => {
    expect(fillerId('q', 'g', 75, [], '')).toBe('q|g|75|bl:');
    expect(fillerId('q', 'g', 75, [], '', '')).toBe('q|g|75|bl:');
    expect(fillerId('q', 'g', 75, ['b', 'a'], '', 'user:bob')).toBe('q|g|75|bl:a,b|src:user:bob');
    expect(fillerId('q', 'g', 75, [], 'x', 'niche:n')).toBe('q|g|75|bl:|mg:x|src:niche:n');
  });
  it('differs between the search, a creator and a niche for the same query', () => {
    const query = parseQuery('red_hair');
    const index = buildMergeIndex([], []);
    const search = pipelineFillerId(query, 75, [], index);
    const user = pipelineFillerId(query, 75, [], index, { kind: 'user', name: 'bob' });
    const niche = pipelineFillerId(query, 75, [], index, { kind: 'niche', id: 'bob' });
    expect(new Set([search, user, niche]).size).toBe(3);
    expect(pipelineFillerId(query, 75, [], index, { kind: 'search' })).toBe(search);
    expect(pipelineFillerId(query, 75, [], index, { kind: 'user', name: 'BOB' })).toBe(user);
  });
  it('a creator stream asks for latest unless an order was given', () => {
    expect(userStreamOrder('trending')).toBe('latest');
    expect(userStreamOrder('top7')).toBe('top7');
    expect(userStreamOrder('latest')).toBe('latest');
  });
});

describe('scoped sidebar estimates', () => {
  it('scopedBaseSize', () => {
    expect(scopedBaseSize([138000], false, undefined)).toBe(138000);
    expect(scopedBaseSize([100, 50], false, 0.5)).toBe(150);
    expect(scopedBaseSize([1000], true, 0.25)).toBe(250);
    expect(scopedBaseSize([1000], true, undefined)).toBeUndefined();
    expect(scopedBaseSize([undefined], false, 1)).toBeUndefined();
    expect(scopedBaseSize([], false, 1)).toBeUndefined();
  });
  it('hasFilters', () => {
    expect(hasFilters(parseQuery(''))).toBe(false);
    expect(hasFilters(parseQuery('order:latest'))).toBe(false);
    expect(hasFilters(parseQuery('a'))).toBe(true);
    expect(hasFilters(parseQuery('-a'))).toBe(true);
    expect(hasFilters(parseQuery('views:>10k'))).toBe(true);
  });
  it('rankSidebarTags with scoped estimates counts from the base even without required tags', () => {
    const tags: TagRow[] = [
      { key: 'a', term: 'a', name: 'A', pageCount: 10 },
      { key: 'b', term: 'b', name: 'B', pageCount: 5 },
    ];
    const rows = rankSidebarTags({ tags, required: [], globalCount: () => 999, canonical: (k) => k, base: 1000, postsOnPage: 10, scoped: true });
    expect(rows.map((r) => [r.key, r.count, r.estimated, r.percent])).toEqual([['a', 1000, true, 100], ['b', 500, true, 50]]);
    const unscoped = rankSidebarTags({ tags, required: [], globalCount: () => 999, canonical: (k) => k, base: undefined, postsOnPage: 10 });
    expect(unscoped.map((r) => [r.count, r.estimated])).toEqual([[999, false], [999, false]]);
  });
});

describe('wiki helpers', () => {
  it('aliasesPointingTo follows chains', () => {
    const map = new Map([['bb', 'big boobs'], ['big boobs', 'big tits'], ['x', 'y']]);
    expect(aliasesPointingTo(map, 'big tits')).toEqual(['bb', 'big boobs']);
    expect(aliasesPointingTo(map, 'nothing')).toEqual([]);
  });
  it('setCategoryOverride replaces, appends and removes lines, keeping comments', () => {
    const text = '# mine\nBig_Tits: act\nred hair: body\n';
    expect(setCategoryOverride(text, 'big tits', 'body')).toBe('# mine\nred hair: body\nbig tits: body\n');
    expect(setCategoryOverride(text, 'blue', 'setting')).toBe('# mine\nBig_Tits: act\nred hair: body\nblue: setting\n');
    expect(setCategoryOverride(text, 'red_hair', null)).toBe('# mine\nBig_Tits: act\n');
    expect(setCategoryOverride('', 'x', null)).toBe('');
    expect(parseCategoryText(setCategoryOverride('', 'Big_Tits', 'body'))).toEqual({ 'big tits': 'body' });
  });
  it('hasCategoryOverride', () => {
    expect(hasCategoryOverride('big_tits: act', 'big tits')).toBe(true);
    expect(hasCategoryOverride('big_tits: act', 'red hair')).toBe(false);
  });
  it('postsWithTag keeps only exact carriers, up to the limit', () => {
    const gifs = [
      { tags: ['Big Tits'] }, { tags: ['big_tits_xl'] }, { tags: ['x', 'BIG tits'] }, { tags: ['big tits'] },
    ];
    expect(postsWithTag(gifs, 'big tits')).toHaveLength(3);
    expect(postsWithTag(gifs, 'big_tits', 2)).toHaveLength(2);
  });
});

describe('safeLink', () => {
  it('allows http(s) only', () => {
    expect(safeLink('https://x.example/a')).toBe('https://x.example/a');
    expect(safeLink('x.example')).toBe('https://x.example/');
    expect(safeLink('javascript:alert(1)')).toBeNull();
    expect(safeLink('')).toBeNull();
  });
});
