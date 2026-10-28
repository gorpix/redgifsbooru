import { describe, expect, it } from 'vitest';
import type { Gif } from '../src/api/types';
import { BUILTIN_IMPLICATIONS } from '../src/search/builtinImplications';
import { PageFiller } from '../src/search/filler';
import { buildImplicationMap, genderOf, implicationSignature, orientationOf, parseImplicationText } from '../src/search/implications';
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
const g = (tags: unknown, m = map, idx?: ReturnType<typeof buildMergeIndex>) => [...genderOf(tags, m, idx)].sort();

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
    expect(g(['boobs'], m)).toEqual([]);
    expect(g(['boobs'], m, idx)).toEqual(['female']);
  });
  it('ignores non-string tags and missing tags', () => {
    expect(g(undefined)).toEqual([]);
    expect(g([1, null, 'shemale'])).toEqual(['trans']);
  });
  it('honours user overrides', () => {
    const m = buildImplicationMap(BUILTIN_IMPLICATIONS, parseImplicationText('tits -> none\nblonde -> female'));
    expect(g(['tits'], m)).toEqual([]);
    expect(g(['blonde'], m)).toEqual(['female']);
  });
});

describe('orientationOf', () => {
  const o = (tags: unknown, sexuality?: unknown, m = map, idx?: ReturnType<typeof buildMergeIndex>) => orientationOf({ tags, sexuality }, m, idx);
  it('trans tags override the sexuality field', () => {
    expect(o(['shemale'])).toBe('trans');
    expect(o(['shemale', 'Big Tits'], ['straight'])).toBe('trans');
    expect(o(['blonde'], ['gay'])).toBe('gay');
  });
  it('maps RedGifs sexuality when the tags are not trans', () => {
    expect(o([], ['trans'])).toBe('trans');
    expect(o([], ['gay'])).toBe('gay');
    expect(o(['Big Tits'], ['gay'])).toBe('gay');
    expect(o(['solo male'], ['straight'])).toBe('straight');
    expect(o([], ['Lesbian'])).toBe('straight');
    expect(o([], ['bisexual'])).toBe('straight');
    expect(o([], ['gay', 'straight'])).toBe('gay');
  });
  it('falls through for animated / unknown / non-array sexuality', () => {
    expect(o([], ['animated'])).toBeNull();
    expect(o(['Big Tits'], ['animated', 'wat'])).toBe('straight');
    expect(o(['solo male'], 'gay')).toBe('gay'); // from tags (not an array)
    expect(o([], 'gay')).toBeNull();
    expect(o([], [])).toBeNull();
  });
  it('derives from tag genders without sexuality', () => {
    expect(o(['Big Tits'])).toBe('straight');
    expect(o(['Big Tits', 'BBC'])).toBe('straight'); // female + male
    expect(o(['BBC'])).toBe('gay'); // male only
    expect(o(['solo male'])).toBe('gay');
    expect(o(['blonde'])).toBeNull();
    expect(o([])).toBeNull();
  });
  it('is merge-canonical aware', () => {
    const m = buildImplicationMap({}, parseImplicationText('tits -> female'));
    const idx = buildMergeIndex([['tits', 'boobs']], []);
    expect(o(['boobs'], undefined, m)).toBeNull();
    expect(o(['boobs'], undefined, m, idx)).toBe('straight');
  });
});

describe('checkGif content filters', () => {
  const q = parseQuery('');
  const f = (orientation: 'any' | 'straight' | 'gay' | 'trans', hideUntagged = false) => ({ hideUntagged, orientation, implications: map });
  const untaggedOnly = { hideUntagged: true };
  it('does nothing without filters or with them off', () => {
    expect(checkGif(gif({ tags: [] }), q, [], NOW)).toBeNull();
    expect(checkGif(gif({ tags: [] }), q, [], NOW, undefined, f('any'))).toBeNull();
    expect(checkGif(gif({ tags: ['blonde'] }), q, [], NOW, undefined, { hideUntagged: false })).toBeNull();
  });
  it('rejects untagged posts', () => {
    expect(checkGif(gif({ tags: [] }), q, [], NOW, undefined, untaggedOnly)).toBe('untagged');
    expect(checkGif(gif({ tags: undefined as unknown as string[] }), q, [], NOW, undefined, untaggedOnly)).toBe('untagged');
    expect(checkGif(gif(), q, [], NOW, undefined, untaggedOnly)).toBeNull();
  });
  it('rejects posts whose orientation differs from the choice, including unknown ones', () => {
    const straight = gif();
    const male = gif({ tags: ['solo male'] });
    const trans = gif({ tags: ['shemale'] });
    const unknown = gif({ tags: ['blonde'] });
    const lesbian = gif({ tags: ['blonde'], sexuality: ['lesbian'] });
    expect(checkGif(straight, q, [], NOW, undefined, f('straight'))).toBeNull();
    expect(checkGif(male, q, [], NOW, undefined, f('straight'))).toBe('orientation');
    expect(checkGif(unknown, q, [], NOW, undefined, f('straight'))).toBe('orientation');
    expect(checkGif(lesbian, q, [], NOW, undefined, f('straight'))).toBeNull();
    expect(checkGif(male, q, [], NOW, undefined, f('gay'))).toBeNull();
    expect(checkGif(straight, q, [], NOW, undefined, f('gay'))).toBe('orientation');
    expect(checkGif(trans, q, [], NOW, undefined, f('trans'))).toBeNull();
    expect(checkGif(trans, q, [], NOW, undefined, f('straight'))).toBe('orientation');
    expect(checkGif(gif({ tags: [], sexuality: ['animated'] }), q, [], NOW, undefined, f('gay'))).toBe('orientation');
  });
  it('orders reasons: blacklist, untagged, orientation, then the query', () => {
    expect(checkGif(gif({ tags: [] }), q, [], NOW, undefined, f('straight', true))).toBe('untagged');
    expect(checkGif(gif({ tags: [] }), q, [], NOW, undefined, f('straight'))).toBe('orientation');
    const bl = [{ mode: 'exact' as const, value: 'blonde', key: 'exact:blonde' }];
    expect(checkGif(gif({ tags: ['blonde'] }), q, bl, NOW, undefined, f('straight'))).toBe('blacklist');
    expect(checkGif(gif({ tags: ['blonde'] }), parseQuery('missing'), [], NOW, undefined, f('straight'))).toBe('orientation');
    expect(checkGif(gif(), parseQuery('missing'), [], NOW, undefined, f('straight'))).toBe('required');
  });
  it('is tallied in FillState.rejected like the blacklist', async () => {
    const gifs = [gif({ id: '1' }), gif({ id: '2', tags: [] }), gif({ id: '3', tags: ['blonde'] })];
    const filler = new PageFiller({
      key: 'k',
      pageSize: 10,
      fetchPage: async (page) => ({ gifs: page === 1 ? gifs : [], pages: 1 }),
      check: (x) => checkGif(x, q, [], NOW, undefined, f('straight', true)),
    });
    const state = await filler.fill(1, () => {});
    expect(state.posts.map((p) => p.id)).toEqual(['1']);
    expect(state.rejected).toEqual({ untagged: 1, orientation: 1 });
  });
});

describe('filler id and settings', () => {
  it('filterSignature is empty when off and distinguishes choices and hashes', () => {
    expect(filterSignature({ hideUntagged: false, orientation: 'any' }, 'zz')).toBe('');
    const u = filterSignature({ hideUntagged: true, orientation: 'any' }, 'zz');
    const sigs = new Set([
      u,
      filterSignature({ hideUntagged: false, orientation: 'gay' }, 'aa'),
      filterSignature({ hideUntagged: false, orientation: 'trans' }, 'aa'),
      filterSignature({ hideUntagged: true, orientation: 'gay' }, 'aa'),
      filterSignature({ hideUntagged: false, orientation: 'gay' }, 'bb'),
    ]);
    expect(sigs.size).toBe(5);
    expect(u).not.toContain('zz'); // the hash only counts with an orientation choice
  });
  it('changes the filler id only when a filter is on, leaving old ids intact', () => {
    const q = parseQuery('a');
    const base = pipelineFillerId(q, 75, [], IDENTITY_INDEX);
    expect(pipelineFillerId(q, 75, [], IDENTITY_INDEX, { kind: 'search' }, '')).toBe(base);
    expect(pipelineFillerId(q, 75, [], IDENTITY_INDEX, { kind: 'search' }, 'u')).not.toBe(base);
    expect(fillerId('q', 'g', 75, [], '', '', 'u')).toBe('q|g|75|bl:|cf:u');
  });
  it('defaults to no filtering', () => {
    expect(DEFAULT_SETTINGS.hideUntagged).toBe(false);
    expect(DEFAULT_SETTINGS.orientation).toBe('any');
    expect('hideUngendered' in DEFAULT_SETTINGS).toBe(false);
  });
  it('the map signature changes with user lines', () => {
    const edited = buildImplicationMap(BUILTIN_IMPLICATIONS, parseImplicationText('pussy -> none'));
    expect(implicationSignature(map)).not.toBe(implicationSignature(edited));
  });
});
