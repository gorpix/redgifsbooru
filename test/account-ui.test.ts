import { describe, expect, it } from 'vitest';
import type { RedgifsApi } from '../src/api/client';
import type { Gif, SearchPage } from '../src/api/types';
import { IDENTITY_INDEX } from '../src/search/merges';
import { parseQuery } from '../src/search/query';
import { NotLoggedInError } from '../src/store/account';
import {
  SetMembership,
  accountGate,
  accountIndicator,
  actionNote,
  describeBlockedImport,
  gateNotice,
  importBlockedTags,
  setNameProblem,
  visibilityLabel,
} from '../src/ui/accountHelpers';
import { gridRouteFor, sourceFromSrc, streamLabel } from '../src/ui/postPageHelpers';
import {
  LIKED_SOURCE,
  SEARCH_SOURCE,
  bumpSetRevision,
  effectiveSource,
  setRevision,
  sourceKey,
  sourceNeedsLogin,
} from '../src/ui/postsHelpers';
import { buildFillerEntry, deriveQuery, pipelineFillerId, streamPages } from '../src/ui/searchPipeline';
import { clearRememberedPages } from '../src/ui/fillers';

const gif = (id: string, tags: string[] = []): Gif => ({
  id, userName: 'u', createDate: 0, views: 1, likes: 0, duration: 1, width: 1, height: 1,
  hasAudio: false, type: 1, tags, niches: [], description: null, verified: false, urls: {},
});

describe('login gate and header indicator', () => {
  it('maps auth states to a gate', () => {
    expect(accountGate('loggedIn')).toBe('ok');
    expect(accountGate('loggedOut')).toBe('loggedOut');
    expect(accountGate('error')).toBe('error');
    expect(accountGate('unknown')).toBe('checking');
  });

  it('shows the user, the login link or the problem link', () => {
    expect(accountIndicator('loggedIn', 'bob')).toEqual({ kind: 'user', label: 'bob' });
    expect(accountIndicator('loggedIn', null)).toEqual({ kind: 'user', label: 'My account' });
    expect(accountIndicator('loggedOut', null)).toEqual({ kind: 'login' });
    expect(accountIndicator('unknown', null)).toEqual({ kind: 'login' });
    expect(accountIndicator('error', null)).toEqual({ kind: 'problem' });
  });

  it('words the notice for a gate', () => {
    expect(gateNotice('ok', 'favorites')).toBeNull();
    expect(gateNotice('loggedOut', 'favorites')).toBe('Log in on RedGifs to see your favorites.');
    expect(gateNotice('checking', 'favorites')).toMatch(/Checking/);
    expect(gateNotice('error', 'favorites')).toMatch(/problem/);
  });
});

describe('actionNote', () => {
  it('asks to log in on NotLoggedInError', () => {
    expect(actionNote(new NotLoggedInError(), 'favorite')).toEqual({ kind: 'login', text: 'Log in on RedGifs to favorite' });
  });
  it('shows a short error otherwise', () => {
    expect(actionNote(new Error('HTTP 500'), 'follow')).toEqual({ kind: 'error', text: 'Could not follow: HTTP 500' });
    expect(actionNote('weird', 'follow')).toEqual({ kind: 'error', text: 'Could not follow' });
  });
});

describe('importBlockedTags', () => {
  it('appends new tags one per line and reports how many', () => {
    expect(importBlockedTags('anal, feet', ['Big_Tits', 'x'])).toEqual({ text: 'anal, feet\nBig_Tits\nx', added: 2 });
  });
  it('skips tags already blacklisted (spelling variants count the same) and duplicates', () => {
    const result = importBlockedTags('big tits\n*part', ['big_tits', 'Big-Tits', 'new', 'NEW', '  ', 'part']);
    expect(result.added).toBe(2);
    expect(result.text).toBe('big tits\n*part\nnew\npart');
  });
  it('leaves the text alone when nothing is new', () => {
    expect(importBlockedTags('a', ['a'])).toEqual({ text: 'a', added: 0 });
    expect(importBlockedTags('', [])).toEqual({ text: '', added: 0 });
  });
  it('starts the text when the blacklist was empty', () => {
    expect(importBlockedTags('', ['a', 'b'])).toEqual({ text: 'a\nb', added: 2 });
  });
  it('describes the outcome', () => {
    expect(describeBlockedImport(0, 0)).toMatch(/no blocked tags/);
    expect(describeBlockedImport(0, 3)).toBe('All 3 blocked tags are already in your blacklist.');
    expect(describeBlockedImport(2, 5)).toBe('Added 2 of 5 blocked tags to your blacklist.');
    expect(describeBlockedImport(1, 1)).toBe('Added 1 of 1 blocked tag to your blacklist.');
  });
});

describe('sets helpers', () => {
  it('validates names', () => {
    expect(setNameProblem('  ')).toMatch(/needs a name/);
    expect(setNameProblem('x'.repeat(101))).toMatch(/at most/);
    expect(setNameProblem(' ok ')).toBeNull();
    expect(visibilityLabel(true)).toBe('public');
    expect(visibilityLabel(false)).toBe('private');
  });

  it('remembers memberships per post and forgets a deleted set', () => {
    const memory = new SetMembership();
    expect(memory.has('g1', 's1')).toBe(false);
    memory.add('g1', 's1');
    memory.add('g2', 's1');
    expect(memory.has('g1', 's1')).toBe(true);
    expect(memory.has('g1', 's2')).toBe(false);
    memory.remove('g1', 's1');
    expect(memory.has('g1', 's1')).toBe(false);
    memory.forgetSet('s1');
    expect(memory.has('g2', 's1')).toBe(false);
  });
});

describe('sources', () => {
  it('keys liked and set sources (sets get a revision after changes)', () => {
    expect(sourceKey(LIKED_SOURCE)).toBe('liked');
    expect(sourceKey({ kind: 'set', id: 'Abc' })).toBe('set:abc');
    bumpSetRevision('Abc');
    expect(setRevision('abc')).toBe(1);
    expect(sourceKey({ kind: 'set', id: 'abc' })).toBe('set:abc#1');
    expect(sourceKey({ kind: 'set', id: 'other' })).toBe('set:other');
  });

  it('a fav:me search on the global search reads my favorites; other sources stay', () => {
    expect(effectiveSource(parseQuery('fav:me a'), SEARCH_SOURCE)).toEqual(LIKED_SOURCE);
    expect(effectiveSource(parseQuery('a'), SEARCH_SOURCE)).toEqual(SEARCH_SOURCE);
    expect(effectiveSource(parseQuery('fav:me'), { kind: 'user', name: 'x' })).toEqual({ kind: 'user', name: 'x' });
  });

  it('knows which sources need a login', () => {
    expect(sourceNeedsLogin(LIKED_SOURCE)).toBe(true);
    expect(sourceNeedsLogin({ kind: 'set', id: 'x' })).toBe(true);
    expect(sourceNeedsLogin(SEARCH_SOURCE)).toBe(false);
    expect(sourceNeedsLogin({ kind: 'niche', id: 'x' })).toBe(false);
  });

  it('parses ?src= values, labels them and finds the grid route', () => {
    expect(sourceFromSrc('liked')).toEqual({ kind: 'liked' });
    expect(sourceFromSrc('set:f1')).toEqual({ kind: 'set', id: 'f1' });
    expect(streamLabel('liked')).toBe('Favorites');
    expect(streamLabel('set:f1')).toBe('Set');
    expect(gridRouteFor({ kind: 'liked' }, 'a', 2)).toEqual({ name: 'favorites', tags: 'a', page: 2 });
    expect(gridRouteFor({ kind: 'set', id: 'f1' }, '', 1)).toEqual({ name: 'set', id: 'f1', tags: '', page: 1 });
    expect(gridRouteFor({ kind: 'search' }, 'x', 3)).toEqual({ name: 'posts', tags: 'x', page: 3 });
    expect(gridRouteFor({ kind: 'user', name: 'bob' }, '', 1)).toEqual({ name: 'user', user: 'bob', tags: '', page: 1 });
    expect(gridRouteFor({ kind: 'niche', id: 'p' }, '', 1)).toEqual({ name: 'pool', id: 'p', tags: '', page: 1 });
  });
});

describe('search pipeline: favorites and sets', () => {
  const emptyAliases = new Map<string, string>();

  it('forceFav makes any text a fav:me query, so the grid and the post page share a filler id', () => {
    const grid = deriveQuery('red_hair', emptyAliases, IDENTITY_INDEX, true);
    const typed = deriveQuery('fav:me red_hair', emptyAliases, IDENTITY_INDEX);
    expect(grid.query.fav).toBe(true);
    expect(grid.queryText).toBe('fav:me red_hair');
    expect(grid.queryText).toBe(typed.queryText);
    const id = (q: typeof grid.query) => pipelineFillerId(q, 75, [], IDENTITY_INDEX, LIKED_SOURCE);
    expect(id(grid.query)).toBe(id(typed.query));
    expect(id(grid.query)).toContain('|src:liked');
    expect(deriveQuery('red_hair', emptyAliases, IDENTITY_INDEX).query.fav).toBe(false);
  });

  it('a set rebuilds its filler id after a revision bump', () => {
    const query = parseQuery('');
    const before = pipelineFillerId(query, 75, [], IDENTITY_INDEX, { kind: 'set', id: 'rev-test' });
    bumpSetRevision('rev-test');
    const after = pipelineFillerId(query, 75, [], IDENTITY_INDEX, { kind: 'set', id: 'rev-test' });
    expect(after).not.toBe(before);
  });

  it('streamPages treats a missing page count as unknown', () => {
    expect(streamPages(5, 30)).toBe(5);
    expect(streamPages(0, 30)).toBe(Infinity);
    expect(streamPages(0, 0)).toBe(0);
  });

  it('the liked source streams likedFeed pages (count 30) and filters client-side', async () => {
    clearRememberedPages();
    const calls: unknown[] = [];
    const page = (n: number): SearchPage => ({
      gifs: n === 1 ? [gif('a', ['blonde']), gif('b', ['brunette']), gif('c', ['blonde'])] : [],
      page: n, pages: 0, total: 3, users: [],
    });
    const api = {
      account: {
        likedFeed: async (params: unknown) => { calls.push(params); return page((params as { page: number }).page); },
        collectionGifs: async () => { throw new Error('not used'); },
      },
      searchGifs: async () => { throw new Error('not used'); },
    } as unknown as RedgifsApi;
    const query = deriveQuery('blonde', emptyAliases, IDENTITY_INDEX, true).query;
    const entry = buildFillerEntry({ api, id: 'test-liked-1', query, rules: [], mergeIndex: IDENTITY_INDEX, pageSize: 75, source: LIKED_SOURCE });
    const state = await entry.filler.fill(1, () => undefined, new AbortController().signal);
    expect(state.phase).toBe('done');
    expect(state.posts.map((g) => g.id)).toEqual(['a', 'c']);
    // First page had posts but no page count: the stream continued to an empty page.
    expect(calls).toEqual([
      { page: 1, count: 30, type: 'g' },
      { page: 2, count: 30, type: 'g' },
    ]);
  });

  it('the set source streams collectionGifs pages', async () => {
    const calls: unknown[][] = [];
    const api = {
      account: {
        collectionGifs: async (...args: unknown[]) => {
          calls.push(args.slice(0, 2));
          return { gifs: [gif('x'), gif('y')], page: 1, pages: 1, total: 2, users: [] } satisfies SearchPage;
        },
      },
    } as unknown as RedgifsApi;
    const entry = buildFillerEntry({ api, id: 'test-set-1', query: parseQuery(''), rules: [], mergeIndex: IDENTITY_INDEX, pageSize: 75, source: { kind: 'set', id: 'f1' } });
    const state = await entry.filler.fill(1, () => undefined, new AbortController().signal);
    expect(state.posts.map((g) => g.id)).toEqual(['x', 'y']);
    expect(calls).toEqual([['f1', { page: 1, count: 100 }]]);
  });
});
