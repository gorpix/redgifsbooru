import { beforeEach, describe, expect, it } from 'vitest';
import type { Gif } from '../src/api/types';
import { buildMergeIndex } from '../src/search/merges';
import { clearRememberedPages, findCached, pagePosts, rememberPage } from '../src/ui/fillers';
import { distinctiveTags, formatAge, neighbours } from '../src/ui/postHelpers';

const g = (id: string) => ({ id }) as Gif;

describe('neighbours', () => {
  const posts = ['a', 'b', 'c'].map(g);
  it('returns both sides in the middle', () => {
    expect(neighbours(posts, 'b')).toEqual({ prev: posts[0], next: posts[2] });
  });
  it('omits the missing side at the edges', () => {
    expect(neighbours(posts, 'a')).toEqual({ prev: undefined, next: posts[1] });
    expect(neighbours(posts, 'c')).toEqual({ prev: posts[1], next: undefined });
  });
  it('is empty for unknown ids and empty lists', () => {
    expect(neighbours(posts, 'zz')).toEqual({});
    expect(neighbours([], 'a')).toEqual({});
  });
});

describe('distinctiveTags', () => {
  const idx = buildMergeIndex([['tits', 'boobs']], []);
  const counts: Record<string, number | null> = { tits: 5_000_000, blonde: 800_000, 'rare thing': 120, 'niche tag': 2_000, pov: 300_000 };
  const countOf = (k: string) => (k in counts ? counts[k] : undefined);

  it('picks the lowest counts that are at least 500', () => {
    expect(distinctiveTags(['Tits', 'Blonde', 'Rare Thing', 'Niche Tag', 'POV'], idx, countOf)).toEqual(['niche tag', 'pov']);
  });
  it('uses merge-canonical keys and removes duplicates', () => {
    expect(distinctiveTags(['Boobs', 'Tits', 'Blonde'], idx, countOf, 3)).toEqual(['blonde', 'tits']);
  });
  it('falls back to the first tags when counts are unknown', () => {
    expect(distinctiveTags(['One', 'Two', 'Three'], idx, () => undefined)).toEqual(['one', 'two']);
  });
  it('tops up with unknown-count tags, then the rest', () => {
    expect(distinctiveTags(['Rare Thing', 'Mystery', 'Niche Tag'], idx, (k) => (k === 'mystery' ? undefined : countOf(k)))).toEqual(['niche tag', 'mystery']);
    expect(distinctiveTags(['Rare Thing', 'Niche Tag'], idx, countOf)).toEqual(['niche tag', 'rare thing']);
  });
  it('handles n and empty input', () => {
    expect(distinctiveTags([], idx, countOf)).toEqual([]);
    expect(distinctiveTags(['Blonde', 'POV'], idx, countOf, 1)).toEqual(['pov']);
  });
});

describe('formatAge', () => {
  const now = Date.UTC(2026, 9, 25, 12, 0, 0);
  const ago = (s: number) => formatAge(now / 1000 - s, now);
  it('formats each unit with singular and plural', () => {
    expect(ago(5)).toBe('just now');
    expect(ago(60)).toBe('1 minute ago');
    expect(ago(59 * 60)).toBe('59 minutes ago');
    expect(ago(3600)).toBe('1 hour ago');
    expect(ago(5 * 3600)).toBe('5 hours ago');
    expect(ago(86400)).toBe('1 day ago');
    expect(ago(3 * 86400 + 100)).toBe('3 days ago');
    expect(ago(45 * 86400)).toBe('1 month ago');
    expect(ago(100 * 86400)).toBe('3 months ago');
    expect(ago(400 * 86400)).toBe('1 year ago');
    expect(ago(800 * 86400)).toBe('2 years ago');
  });
  it('treats the future as just now', () => {
    expect(ago(-500)).toBe('just now');
  });
});

describe('remembered pages', () => {
  beforeEach(() => clearRememberedPages());
  it('stores and finds posts by page and id', () => {
    rememberPage('f1', 1, [g('a'), g('b')]);
    rememberPage('f1', 2, [g('c')]);
    expect(pagePosts('f1', 1)?.map((x) => x.id)).toEqual(['a', 'b']);
    expect(pagePosts('f1', 3)).toBeUndefined();
    expect(pagePosts('other', 1)).toBeUndefined();
    expect(findCached('c')?.id).toBe('c');
    expect(findCached('zz')).toBeUndefined();
  });
  it('replaces a page that is remembered again', () => {
    rememberPage('f1', 1, [g('a')]);
    rememberPage('f1', 1, [g('b')]);
    expect(pagePosts('f1', 1)?.map((x) => x.id)).toEqual(['b']);
    expect(findCached('a')).toBeUndefined();
  });
  it('keeps at most 20 pages, dropping the oldest', () => {
    for (let p = 1; p <= 21; p++) rememberPage('f', p, [g(`id${p}`)]);
    expect(pagePosts('f', 1)).toBeUndefined();
    expect(pagePosts('f', 2)).toBeDefined();
    expect(pagePosts('f', 21)).toBeDefined();
    expect(findCached('id1')).toBeUndefined();
  });
  it('refreshes a page that is remembered again so it is dropped last', () => {
    for (let p = 1; p <= 20; p++) rememberPage('f', p, [g(`id${p}`)]);
    rememberPage('f', 1, [g('id1')]);
    rememberPage('f', 21, [g('id21')]);
    expect(pagePosts('f', 1)).toBeDefined();
    expect(pagePosts('f', 2)).toBeUndefined();
  });
});
