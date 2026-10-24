import { describe, expect, it } from 'vitest';
import type { Gif } from '../src/api/types';
import type { Category } from '../src/search/categories';
import { buildMergeIndex, IDENTITY_INDEX } from '../src/search/merges';
import { formatNicheName } from '../src/ui/format';
import {
  sourceFromSrc,
  streamLabel,
  availableMediaHeight,
  canonicalKeys,
  fitSize,
  isSplitLayout,
  readPlayerPrefs,
  sortTagRows,
  thumbsPerRow,
  updatePlayerPrefs,
  visibleThumbCount,
  downloadName,
  filterRelated,
  groupTagsByCategory,
  keyAction,
  locateNeighbour,
  parsePlayerPrefs,
  pickUnknownCounts,
  postTitle,
  resolveNeighbour,
  spellingFor,
  withoutPost,
} from '../src/ui/postPageHelpers';

const g = (id: string, tags: string[] = []) => ({ id, tags }) as Gif;

describe('groupTagsByCategory', () => {
  const builtin: Record<string, Category> = { 'big tits': 'body', blowjob: 'act', beach: 'setting', hd: 'meta' };
  it('groups in CATEGORY_ORDER, defaults to general, leaves empty groups out', () => {
    const groups = groupTagsByCategory(['HD', 'Beach', 'Blowjob', 'Big Tits', 'Weird'], builtin, {}, IDENTITY_INDEX);
    expect(groups.map((x) => x.category)).toEqual(['body', 'act', 'setting', 'general', 'meta']);
    expect(groups[0].tags).toEqual([{ key: 'big tits', name: 'big tits' }]);
    expect(groups[3].tags[0].key).toBe('weird');
  });
  it('lets user categories win and merges duplicates to the canonical key', () => {
    const idx = buildMergeIndex([['tits', 'boobs']], []);
    const groups = groupTagsByCategory(['Boobs', 'Tits', 'Beach'], builtin, { beach: 'general', tits: 'body' }, idx);
    expect(groups.map((x) => [x.category, x.tags.map((t) => t.key)])).toEqual([
      ['body', ['tits']],
      ['general', ['beach']],
    ]);
  });
  it('lists a tag mapped to creator as general', () => {
    expect(groupTagsByCategory(['x'], {}, { x: 'creator' }, IDENTITY_INDEX)[0].category).toBe('general');
  });
  it('is empty without tags', () => {
    expect(groupTagsByCategory([], builtin, {}, IDENTITY_INDEX)).toEqual([]);
  });
});

describe('count lookups', () => {
  it('canonicalKeys dedupes by merge group', () => {
    const idx = buildMergeIndex([['tits', 'boobs']], []);
    expect(canonicalKeys(['Boobs', 'Tits', 'A_B'], idx)).toEqual(['tits', 'a b']);
  });
  it('pickUnknownCounts takes at most the limit of unknown keys', () => {
    const keys = Array.from({ length: 12 }, (_, i) => `k${i}`);
    const known = new Set(['k0', 'k1']);
    const picked = pickUnknownCounts(keys, (k) => (known.has(k) ? 5 : undefined), 8);
    expect(picked).toEqual(['k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9']);
    expect(pickUnknownCounts(['a'], () => null)).toEqual([]);
  });
});

describe('keyAction', () => {
  const press = (key: string, extra: object = {}) => keyAction({ key, target: { tagName: 'BODY' }, ...extra });
  it('maps arrows and a/d', () => {
    expect(press('ArrowLeft')).toBe('prev');
    expect(press('a')).toBe('prev');
    expect(press('ArrowRight')).toBe('next');
    expect(press('d')).toBe('next');
    expect(press('x')).toBeNull();
  });
  it('ignores typing targets and modifiers', () => {
    expect(keyAction({ key: 'a', target: { tagName: 'INPUT' } })).toBeNull();
    expect(keyAction({ key: 'd', target: { tagName: 'textarea' } })).toBeNull();
    expect(keyAction({ key: 'd', target: { tagName: 'SELECT' } })).toBeNull();
    expect(keyAction({ key: 'd', target: { tagName: 'DIV', isContentEditable: true } })).toBeNull();
    expect(press('ArrowLeft', { altKey: true })).toBeNull();
    expect(press('a', { ctrlKey: true })).toBeNull();
    expect(press('d', { metaKey: true })).toBeNull();
    expect(press('ArrowRight', { shiftKey: true })).toBeNull();
  });
});

describe('download names, title and player prefs', () => {
  it('names files', () => {
    expect(downloadName('abc', 'hd')).toBe('abc.mp4');
    expect(downloadName('abc', 'sd')).toBe('abc-sd.mp4');
    expect(downloadName('abc', 'image')).toBe('abc.jpg');
  });
  it('builds the title from the first 3 tags', () => {
    expect(postTitle('abc', ['Big Tits', 'Blonde', 'POV', 'Extra'], 'S')).toBe('big_tits blonde pov – post abc | S');
    expect(postTitle('abc', null, 'S')).toBe('post abc | S');
  });
  it('starts muted unless the user unmuted before', () => {
    expect(parsePlayerPrefs(null)).toEqual({ muted: true, volume: 1, scale: 'fit' });
    expect(parsePlayerPrefs('not json')).toEqual({ muted: true, volume: 1, scale: 'fit' });
    expect(parsePlayerPrefs('{"muted":false,"volume":0.4}')).toEqual({ muted: false, volume: 0.4, scale: 'fit' });
    expect(parsePlayerPrefs('{"muted":"no","volume":9}')).toEqual({ muted: true, volume: 1, scale: 'fit' });
  });
});

describe('related filters', () => {
  const idx = buildMergeIndex([['tits', 'boobs']], []);
  it('spellingFor uses the post spelling', () => {
    expect(spellingFor('big tits', ['Blonde', 'Big Tits'], idx)).toBe('Big Tits');
    expect(spellingFor('tits', ['Boobs'], idx)).toBe('Boobs');
    expect(spellingFor('zzz', ['a'], idx)).toBe('zzz');
  });
  it('keeps posts with both tags, drops self and duplicates, caps the count', () => {
    const gifs = [g('self', ['a', 'b']), g('1', ['A', 'Boobs']), g('2', ['a']), g('1', ['a', 'tits']), g('3', ['tits', 'a']), g('4', ['a', 'tits'])];
    expect(filterRelated(gifs, ['a', 'tits'], idx, 'self', 2).map((x) => x.id)).toEqual(['1', '3']);
  });
  it('withoutPost drops the current post', () => {
    expect(withoutPost([g('1'), g('2'), g('3')], '2', 5).map((x) => x.id)).toEqual(['1', '3']);
    expect(withoutPost([g('1'), g('2'), g('3')], '9', 2).map((x) => x.id)).toEqual(['1', '2']);
  });
});

describe('prev / next', () => {
  const pages: Record<number, Gif[]> = { 1: [g('a'), g('b')], 2: [g('c'), g('d')], 3: [] };
  const pageOf = (p: number) => pages[p];

  it('uses the plain neighbour inside a page', () => {
    expect(locateNeighbour(1, 'a', 1, pageOf)).toMatchObject({ kind: 'found', page: 1, gif: { id: 'b' } });
    expect(locateNeighbour(-1, 'd', 2, pageOf)).toMatchObject({ kind: 'found', page: 2, gif: { id: 'c' } });
  });
  it('crosses page edges', () => {
    expect(locateNeighbour(1, 'b', 1, pageOf)).toMatchObject({ kind: 'found', page: 2, gif: { id: 'c' } });
    expect(locateNeighbour(-1, 'c', 2, pageOf)).toMatchObject({ kind: 'found', page: 1, gif: { id: 'b' } });
  });
  it('has nothing before page 1, after an empty page, or for an unlisted post', () => {
    expect(locateNeighbour(-1, 'a', 1, pageOf)).toEqual({ kind: 'none' });
    expect(locateNeighbour(1, 'd', 2, pageOf)).toEqual({ kind: 'none' });
    expect(locateNeighbour(1, 'zz', 1, pageOf)).toEqual({ kind: 'none' });
  });
  it('asks for a missing page', () => {
    expect(locateNeighbour(1, 'a', 5, pageOf)).toEqual({ kind: 'unknown', needPage: 5 });
    expect(locateNeighbour(1, 'd', 2, (p) => (p === 2 ? pages[2] : undefined))).toEqual({ kind: 'unknown', needPage: 3 });
  });
  it('resolveNeighbour loads what is missing, then answers', async () => {
    const asked: number[] = [];
    const load = async (p: number) => { asked.push(p); return pages[p]; };
    const found = await resolveNeighbour(1, 'd', 2, (p) => (p === 2 ? pages[2] : undefined), async (p) => { asked.push(p); return [g('e'), g('f')]; });
    expect(found).toMatchObject({ kind: 'found', page: 3, gif: { id: 'e' } });
    expect(asked).toEqual([3]);
    expect(await resolveNeighbour(1, 'a', 1, () => undefined, load)).toMatchObject({ kind: 'found', gif: { id: 'b' } });
    expect(await resolveNeighbour(1, 'a', 1, () => undefined, async () => undefined)).toEqual({ kind: 'none' });
  });
});

describe('player prefs storage', () => {
  const store = (initial?: string) => {
    let value: string | null = initial ?? null;
    return {
      getItem: () => value,
      setItem: (_k: string, v: string) => { value = v; },
      get value() { return value; },
    };
  };
  it('starts muted at full volume with Fit when nothing is saved', () => {
    expect(readPlayerPrefs(store())).toEqual({ muted: true, volume: 1, scale: 'fit' });
    expect(readPlayerPrefs(null)).toEqual({ muted: true, volume: 1, scale: 'fit' });
  });
  it('remembers muted, volume and scale across reads, merging patches', () => {
    const s = store();
    updatePlayerPrefs({ muted: false, volume: 0.3 }, s);
    updatePlayerPrefs({ scale: 'width' }, s);
    expect(readPlayerPrefs(s)).toEqual({ muted: false, volume: 0.3, scale: 'width' });
    updatePlayerPrefs({ volume: 0.6 }, s);
    expect(readPlayerPrefs(s)).toEqual({ muted: false, volume: 0.6, scale: 'width' });
  });
  it('reads old prefs without a scale and rejects bad scales', () => {
    expect(parsePlayerPrefs('{"muted":false,"volume":0.4}').scale).toBe('fit');
    expect(parsePlayerPrefs('{"scale":"huge"}').scale).toBe('fit');
    expect(parsePlayerPrefs('{"scale":"original"}').scale).toBe('original');
  });
  it('survives blocked storage', () => {
    const blocked = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(readPlayerPrefs(blocked)).toEqual({ muted: true, volume: 1, scale: 'fit' });
    expect(() => updatePlayerPrefs({ muted: false }, blocked)).not.toThrow();
  });
});

describe('fitSize', () => {
  const media = { width: 1000, height: 500 };
  it('fit shrinks inside the box and never enlarges', () => {
    expect(fitSize('fit', { width: 500, height: 1000 }, media)).toEqual({ width: 500, height: 250 });
    expect(fitSize('fit', { width: 2000, height: 100 }, media)).toEqual({ width: 200, height: 100 });
    expect(fitSize('fit', { width: 4000, height: 4000 }, media)).toEqual({ width: 1000, height: 500 });
    expect(fitSize('fit', { width: 400, height: Infinity }, media)).toEqual({ width: 400, height: 200 });
  });
  it('width and height fill one dimension', () => {
    expect(fitSize('width', { width: 2000, height: 100 }, media)).toEqual({ width: 2000, height: 1000 });
    expect(fitSize('height', { width: 100, height: 250 }, media)).toEqual({ width: 500, height: 250 });
  });
  it('original is the natural size; unusable sizes give null', () => {
    expect(fitSize('original', { width: 10, height: 10 }, media)).toEqual(media);
    expect(fitSize('fit', { width: 10, height: 10 }, { width: 0, height: 5 })).toBeNull();
    expect(fitSize('width', { width: 0, height: 10 }, media)).toBeNull();
  });
});

describe('availableMediaHeight', () => {
  it('subtracts everything else from the viewport and has a floor', () => {
    expect(availableMediaHeight({ viewportHeight: 1000, above: 100, bar: 24, below: 300, margin: 16 })).toBe(560);
    expect(availableMediaHeight({ viewportHeight: 300, above: 100, bar: 24, below: 300 })).toBe(160);
  });
});

describe('related layout', () => {
  it('counts whole thumbnails per row', () => {
    expect(thumbsPerRow(150)).toBe(1);
    expect(thumbsPerRow(155)).toBe(1);
    expect(thumbsPerRow(312)).toBe(2); // 150+6+150 = 306
    expect(thumbsPerRow(305)).toBe(1);
    expect(thumbsPerRow(0)).toBe(1);
    expect(thumbsPerRow(900)).toBe(5);
    expect(visibleThumbCount(900, 1)).toBe(5);
    expect(visibleThumbCount(900, 2)).toBe(10);
  });
  it('splits at 900px', () => {
    expect(isSplitLayout(899)).toBe(false);
    expect(isSplitLayout(900)).toBe(true);
  });
});

describe('tag order and niche names', () => {
  it('sorts rows alphabetically by shown name, case-insensitive', () => {
    const rows = [{ key: 'zebra', name: 'zebra' }, { key: 'Apple', name: 'Apple' }, { key: 'banana', name: 'banana' }];
    expect(sortTagRows(rows).map((r) => r.name)).toEqual(['Apple', 'banana', 'zebra']);
    expect(rows[0].name).toBe('zebra');
  });
  it('groups come out sorted', () => {
    const groups = groupTagsByCategory(['Zed', 'alpha', 'Mid'], {}, {}, IDENTITY_INDEX);
    expect(groups[0].tags.map((t) => t.key)).toEqual(['alpha', 'mid', 'zed']);
  });
  it('formats niche names', () => {
    expect(formatNicheName('pale-girls')).toBe('Pale girls');
    expect(formatNicheName('milf')).toBe('Milf');
    expect(formatNicheName('')).toBe('');
  });
});

describe('sourceFromSrc / streamLabel', () => {
  it('maps src to a pipeline source', () => {
    expect(sourceFromSrc('')).toEqual({ kind: 'search' });
    expect(sourceFromSrc('user:Foo Bar')).toEqual({ kind: 'user', name: 'Foo Bar' });
    expect(sourceFromSrc('niche:pale-girls')).toEqual({ kind: 'niche', id: 'pale-girls' });
  });
  it('labels the stream', () => {
    expect(streamLabel('')).toBe('Search');
    expect(streamLabel('user:Foo')).toBe('Foo');
    expect(streamLabel('niche:pale-girls')).toBe('Pool: Pale girls');
  });
});
