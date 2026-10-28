import { describe, expect, it } from 'vitest';
import type { Gif } from '../src/api/types';
import { BUILTIN_IMPLICATIONS } from '../src/search/builtinImplications';
import { PageFiller } from '../src/search/filler';
import { buildImplicationMap, genderOf, implicationSignature, parseImplicationText } from '../src/search/implications';
import { checkGif } from '../src/search/match';
import { IDENTITY_INDEX, buildMergeIndex } from '../src/search/merges';
import { parseQuery } from '../src/search/query';
import { getImplicationText, setImplicationText } from '../src/store/implications';
import { DEFAULT_SETTINGS } from '../src/store/settings';
import { fillerId, filterSignature } from '../src/ui/postsHelpers';
import { pipelineFillerId } from '../src/ui/searchPipeline';

const NOW = 1_800_000_000;
const gif = (over: Partial<Gif> = {}): Gif => ({
  id: 'a', userName: 'u', createDate: NOW - 86400, views: 1000, likes: 10, duration: 5, width: 100, height: 100,
  hasAudio: false, type: 1, tags: ['Big Tits'], niches: [], description: null, verified: false, urls: {}, ...over,
});
const map = buildImplicationMap(BUILTIN_IMPLICATIONS, []);
const g = (tags: unknown, sexuality?: unknown, m = map, idx?: ReturnType<typeof buildMergeIndex>) =>
  [...genderOf(tags, sexuality, m, idx)].sort();

describe('parseImplicationText', () => {
  it('parses genders, comments, none and skips junk', () => {
    const parsed = parseImplicationText('# c\nFoo_Bar -> Female\nbaz => female, male\nqux -> none\nbad -> robot\nno separator\n -> male\nfoo bar -> trans');
    expect(parsed).toEqual([
      { tag: 'foo bar', genders: ['trans'] }, // later line wins
      { tag: 'baz', genders: ['female', 'male'] },
      { tag: 'qux', genders: [] },
    ]);
  });
  it('rejects none mixed with genders and tolerates empty input', () => {
    expect(parseImplicationText('a -> none, male')).toEqual([]);
    expect(parseImplicationText('')).toEqual([]);
  });
});

describe('implications store', () => {
  it('round-trips raw text', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
    expect(getImplicationText(storage)).toBe('');
    setImplicationText('a -> male', storage);
    expect(data.get('rgb:implications')).toBe('a -> male');
    expect(getImplicationText(storage)).toBe('a -> male');
  });
});

describe('buildImplicationMap', () => {
  it('lets user lines override built-ins and none remove them', () => {
    const m = buildImplicationMap(BUILTIN_IMPLICATIONS, parseImplicationText('pussy -> trans\ndick -> none\nnewtag -> male'));
    expect(m.get('pussy')).toEqual(['trans']);
    expect(m.has('dick')).toBe(false);
    expect(m.get('newtag')).toEqual(['male']);
    expect(m.get('tits')).toEqual(['female']);
  });
  it('has normalized keys and sane built-ins', () => {
    for (const k of Object.keys(BUILTIN_IMPLICATIONS)) expect(k).toBe(k.toLowerCase().replace(/[_-]/g, ' ').trim());
    expect(Object.keys(BUILTIN_IMPLICATIONS).length).toBeGreaterThanOrEqual(150);
    expect(BUILTIN_IMPLICATIONS['solo']).toBeUndefined();
  });
});

describe('genderOf', () => {
  it('unions what tags imply, normalizing tags', () => {
    expect(g(['Big_Tits', 'blonde'])).toEqual(['female']);
    expect(g(['Big Tits', 'BBC'])).toEqual(['female', 'male']);
    expect(g(['shemale'])).toEqual(['trans']);
    expect(g(['straight'])).toEqual(['female', 'male']);
    expect(g(['blonde', 'outdoor'])).toEqual([]);
  });
  it('applies the solo rules', () => {
    expect(g(['solo'])).toEqual([]);
    expect(g(['solo female'])).toEqual(['female']);
    expect(g(['solo girl'])).toEqual(['female']);
    expect(g(['solo male'])).toEqual(['male']);
    expect(g(['solo guy'])).toEqual(['male']);
  });
  it('looks up the merge-canonical key too', () => {
    const m = buildImplicationMap({}, parseImplicationText('tits -> female'));
    const idx = buildMergeIndex([['tits', 'boobs']], []);
    expect(g(['boobs'], undefined, m)).toEqual([]);
    expect(g(['boobs'], undefined, m, idx)).toEqual(['female']);
  });
  it('uses sexuality only when the post has no tags', () => {
    expect(g([], ['lesbian'])).toEqual(['female']);
    expect(g(undefined, ['gay'])).toEqual(['male']);
    expect(g([], ['Straight'])).toEqual(['female', 'male']);
    expect(g([], ['bisexual'])).toEqual(['female', 'male']);
    expect(g([], ['trans'])).toEqual(['trans']);
    expect(g([], ['animated'])).toEqual([]);
    expect(g([], [])).toEqual([]);
    expect(g([], 'lesbian')).toEqual([]);
    expect(g(['blonde'], ['lesbian'])).toEqual([]); // tagged: sexuality ignored
  });
  it('honours user overrides', () => {
    const m = buildImplicationMap(BUILTIN_IMPLICATIONS, parseImplicationText('tits -> none\nblonde -> female'));
    expect(g(['tits'], undefined, m)).toEqual([]);
    expect(g(['blonde'], undefined, m)).toEqual(['female']);
  });
});

describe('checkGif content filters', () => {
  const q = parseQuery('');
  const on = { hideUntagged: true, hideUngendered: true, implications: map };
  const untaggedOnly = { hideUntagged: true, hideUngendered: false };
  it('does nothing without filters or with them off', () => {
    expect(checkGif(gif({ tags: [] }), q, [], NOW)).toBeNull();
    expect(checkGif(gif({ tags: [] }), q, [], NOW, undefined, { hideUntagged: false, hideUngendered: false, implications: map })).toBeNull();
  });
  it('rejects untagged posts', () => {
    expect(checkGif(gif({ tags: [] }), q, [], NOW, undefined, untaggedOnly)).toBe('untagged');
    expect(checkGif(gif({ tags: undefined as unknown as string[] }), q, [], NOW, undefined, untaggedOnly)).toBe('untagged');
    expect(checkGif(gif(), q, [], NOW, undefined, untaggedOnly)).toBeNull();
  });
  it('rejects ungendered posts, using sexuality for untagged ones', () => {
    const noUntagged = { ...on, hideUntagged: false };
    expect(checkGif(gif({ tags: ['blonde'] }), q, [], NOW, undefined, on)).toBe('ungendered');
    expect(checkGif(gif({ tags: ['blonde'], sexuality: ['lesbian'] }), q, [], NOW, undefined, on)).toBe('ungendered');
    expect(checkGif(gif({ tags: [], sexuality: ['gay'] }), q, [], NOW, undefined, noUntagged)).toBeNull();
    expect(checkGif(gif({ tags: [], sexuality: ['animated'] }), q, [], NOW, undefined, noUntagged)).toBe('ungendered');
    expect(checkGif(gif(), q, [], NOW, undefined, on)).toBeNull();
  });
  it('orders reasons: blacklist, untagged, ungendered, then the query', () => {
    expect(checkGif(gif({ tags: [] }), q, [], NOW, undefined, on)).toBe('untagged');
    const bl = [{ mode: 'exact' as const, value: 'blonde', key: 'exact:blonde' }];
    expect(checkGif(gif({ tags: ['blonde'] }), q, bl, NOW, undefined, on)).toBe('blacklist');
    expect(checkGif(gif({ tags: [] }), parseQuery('missing'), [], NOW, undefined, on)).toBe('untagged');
  });
  it('is tallied in FillState.rejected like the blacklist', async () => {
    const gifs = [gif({ id: '1' }), gif({ id: '2', tags: [] }), gif({ id: '3', tags: ['blonde'] })];
    const filler = new PageFiller({
      key: 'k',
      pageSize: 10,
      fetchPage: async (page) => ({ gifs: page === 1 ? gifs : [], pages: 1 }),
      check: (x) => checkGif(x, q, [], NOW, undefined, on),
    });
    const state = await filler.fill(1, () => {});
    expect(state.posts.map((p) => p.id)).toEqual(['1']);
    expect(state.rejected).toEqual({ untagged: 1, ungendered: 1 });
  });
});

describe('filler id and settings', () => {
  it('filterSignature is empty when off and distinguishes flags and hashes', () => {
    expect(filterSignature({ hideUntagged: false, hideUngendered: false }, 'zz')).toBe('');
    const u = filterSignature({ hideUntagged: true, hideUngendered: false }, 'zz');
    const sigs = new Set([
      u,
      filterSignature({ hideUntagged: false, hideUngendered: true }, 'aa'),
      filterSignature({ hideUntagged: true, hideUngendered: true }, 'aa'),
      filterSignature({ hideUntagged: false, hideUngendered: true }, 'bb'),
    ]);
    expect(sigs.size).toBe(4);
    expect(u).not.toContain('zz'); // the hash only counts with hideUngendered
  });
  it('changes the filler id only when a filter is on, leaving old ids intact', () => {
    const q = parseQuery('a');
    const base = pipelineFillerId(q, 75, [], IDENTITY_INDEX);
    expect(pipelineFillerId(q, 75, [], IDENTITY_INDEX, { kind: 'search' }, '')).toBe(base);
    expect(pipelineFillerId(q, 75, [], IDENTITY_INDEX, { kind: 'search' }, 'u')).not.toBe(base);
    expect(fillerId('q', 'g', 75, [], '', '', 'u')).toBe('q|g|75|bl:|cf:u');
  });
  it('defaults both filters to off', () => {
    expect(DEFAULT_SETTINGS.hideUntagged).toBe(false);
    expect(DEFAULT_SETTINGS.hideUngendered).toBe(false);
  });
  it('the map signature changes with user lines', () => {
    const edited = buildImplicationMap(BUILTIN_IMPLICATIONS, parseImplicationText('pussy -> none'));
    expect(implicationSignature(map)).not.toBe(implicationSignature(edited));
  });
});
