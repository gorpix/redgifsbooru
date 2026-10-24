import { describe, expect, it } from 'vitest';
import type { Gif } from '../src/api/types';
import { checkGif, favoriteScore, parseBlacklist, sortPage } from '../src/search/match';
import { parseQuery } from '../src/search/query';

const NOW = 1_800_000_000;

function gif(over: Partial<Gif> = {}): Gif {
  return {
    id: 'a',
    userName: 'u',
    createDate: NOW - 86400,
    views: 1000,
    likes: 10,
    duration: 5,
    width: 100,
    height: 100,
    hasAudio: false,
    type: 1,
    tags: ['Big Tits', 'blonde'],
    niches: [],
    description: null,
    verified: false,
    urls: {},
    ...over,
  };
}

describe('parseBlacklist', () => {
  it('splits on commas and newlines and trims', () => {
    const rules = parseBlacklist('Foo Bar, baz\r\n  qux  ,,\n\n');
    expect(rules.map((r) => r.key)).toEqual(['exact:foo bar', 'exact:baz', 'exact:qux']);
  });

  it('handles partial, leading dash and quotes', () => {
    const rules = parseBlacklist('*feet, -anal, "big tits", *"hot dog", \'x_y\'');
    expect(rules).toEqual([
      { mode: 'partial', value: 'feet', key: 'partial:feet' },
      { mode: 'exact', value: 'anal', key: 'exact:anal' },
      { mode: 'exact', value: 'big tits', key: 'exact:big tits' },
      { mode: 'partial', value: 'hot dog', key: 'partial:hot dog' },
      { mode: 'exact', value: 'x y', key: 'exact:x y' },
    ]);
  });

  it('de-duplicates by key and skips empties', () => {
    const rules = parseBlacklist('a, A, -a, *a, *, "", ,');
    expect(rules.map((r) => r.key)).toEqual(['exact:a', 'partial:a']);
  });

  it('tolerates empty input', () => {
    expect(parseBlacklist('')).toEqual([]);
  });
});

describe('favoriteScore', () => {
  it('returns null when it cannot be computed', () => {
    expect(favoriteScore({ likes: 5, views: null })).toBeNull();
    expect(favoriteScore({ likes: 5, views: NaN })).toBeNull();
    expect(favoriteScore({ likes: NaN, views: 100 })).toBeNull();
    expect(favoriteScore({ likes: 5, views: Infinity })).toBeNull();
  });

  it('scores a brand-new post (0 views) at 50', () => {
    expect(favoriteScore({ likes: 0, views: 0 })).toBe(50);
    expect(favoriteScore({ likes: 0, views: -3 })).toBe(50);
  });

  it('puts a typical post (0.25 % over many views) near 50 and doubling at +25', () => {
    expect(favoriteScore({ likes: 2500, views: 1_000_000 })).toBe(50);
    expect(favoriteScore({ likes: 5000, views: 1_000_000 })).toBe(75);
    expect(favoriteScore({ likes: 1250, views: 1_000_000 })).toBe(25);
  });

  it('gives sensible values for small samples', () => {
    expect(favoriteScore({ likes: 0, views: 1000 })).toBe(35);
    expect(favoriteScore({ likes: -5, views: 1000 })).toBe(35);
    expect(favoriteScore({ likes: 1, views: 1000 })).toBe(42);
    expect(favoriteScore({ likes: 10, views: 1000 })).toBe(75);
    expect(favoriteScore({ likes: 1, views: 100 })).toBe(55);
  });

  it('clamps to 0..100', () => {
    expect(favoriteScore({ likes: 0, views: 1_000_000 })).toBe(0);
    expect(favoriteScore({ likes: 1, views: 10_000 })).toBe(0);
    expect(favoriteScore({ likes: 50, views: 100 })).toBe(100);
  });
});

describe('checkGif', () => {
  const q = (text: string) => parseQuery(text);

  it('accepts a matching post', () => {
    expect(checkGif(gif(), q('big_tits blonde'), [], NOW)).toBeNull();
    expect(checkGif(gif(), q(''), [], NOW)).toBeNull();
  });

  it('rejects by blacklist first', () => {
    const rules = parseBlacklist('blonde');
    expect(checkGif(gif(), q('-blonde missing'), rules, NOW)).toBe('blacklist');
    expect(checkGif(gif(), q(''), parseBlacklist('*tit'), NOW)).toBe('blacklist');
    expect(checkGif(gif(), q(''), parseBlacklist('tit'), NOW)).toBeNull();
  });

  it('rejects by exact and partial exclusion', () => {
    expect(checkGif(gif(), q('-blonde'), [], NOW)).toBe('exclude');
    expect(checkGif(gif(), q('-blond'), [], NOW)).toBeNull();
    expect(checkGif(gif(), q('--blond'), [], NOW)).toBe('exclude');
    expect(checkGif(gif(), q('--big_t'), [], NOW)).toBe('exclude');
    expect(checkGif(gif(), q('-big_tits'), [], NOW)).toBe('exclude');
  });

  it('rejects by required, exact equality', () => {
    expect(checkGif(gif(), q('brunette'), [], NOW)).toBe('required');
    expect(checkGif(gif(), q('blonde brunette'), [], NOW)).toBe('required');
    expect(checkGif(gif(), q('blond'), [], NOW)).toBe('required');
  });

  it('rejects by any-group', () => {
    expect(checkGif(gif(), q('~x ~y'), [], NOW)).toBe('any');
    expect(checkGif(gif(), q('~x ~blonde'), [], NOW)).toBeNull();
  });

  it('rejects by meta', () => {
    expect(checkGif(gif(), q('views:>5k'), [], NOW)).toBe('meta');
    expect(checkGif(gif(), q('views:>500'), [], NOW)).toBeNull();
  });

  it('reports the first failing reason in order', () => {
    const query = q('missing ~nope views:>1m -blonde');
    expect(checkGif(gif(), query, [], NOW)).toBe('exclude');
    expect(checkGif(gif(), q('missing ~nope views:>1m'), [], NOW)).toBe('required');
    expect(checkGif(gif(), q('~nope views:>1m'), [], NOW)).toBe('any');
    expect(checkGif(gif(), q('views:>1m'), [], NOW)).toBe('meta');
  });

  it('applies views, favs and score filters with range edges', () => {
    expect(checkGif(gif(), q('views:1000'), [], NOW)).toBeNull();
    expect(checkGif(gif(), q('views:>1000'), [], NOW)).toBe('meta');
    expect(checkGif(gif(), q('views:>=1000'), [], NOW)).toBeNull();
    expect(checkGif(gif(), q('views:1k..2k'), [], NOW)).toBeNull();
    expect(checkGif(gif(), q('favs:<10'), [], NOW)).toBe('meta');
    expect(checkGif(gif(), q('likes:10'), [], NOW)).toBeNull();
    expect(checkGif(gif(), q('score:>=75'), [], NOW)).toBeNull();
    expect(checkGif(gif(), q('score:>75'), [], NOW)).toBe('meta');
  });

  it('applies age filters', () => {
    expect(checkGif(gif(), q('age:<2d'), [], NOW)).toBeNull();
    expect(checkGif(gif(), q('age:<12h'), [], NOW)).toBe('meta');
    expect(checkGif(gif(), q('age:1d'), [], NOW)).toBeNull(); // within 1d, inclusive
    expect(checkGif(gif({ createDate: NOW - 90 * 86400 }), q('age:<30d'), [], NOW)).toBe('meta');
    expect(checkGif(gif({ createDate: NOW - 90 * 86400 }), q('age:>30d'), [], NOW)).toBeNull();
    expect(checkGif(gif({ createDate: NOW - 5 * 86400 }), q('date:7d'), [], NOW)).toBeNull();
    expect(checkGif(gif({ createDate: NOW - 8 * 86400 }), q('date:7d'), [], NOW)).toBe('meta');
  });

  it('applies date window filters', () => {
    const day = new Date(2026, 0, 15).getTime() / 1000;
    const g = gif({ createDate: day + 3600 });
    expect(checkGif(g, q('date:2026-01-15'), [], NOW)).toBeNull();
    expect(checkGif(g, q('date:2026-01-14'), [], NOW)).toBe('meta');
    expect(checkGif(g, q('date:>2026-01-15'), [], NOW)).toBeNull(); // compares against midnight
    expect(checkGif(g, q('date:<2026-01-15'), [], NOW)).toBe('meta');
    expect(checkGif(g, q('date:2026-01-01..2026-02-01'), [], NOW)).toBeNull();
  });

  it('treats millisecond createDate as ms', () => {
    const g = gif({ createDate: (NOW - 86400) * 1000 });
    expect(checkGif(g, q('age:<2d'), [], NOW)).toBeNull();
    expect(checkGif(g, q('age:<12h'), [], NOW)).toBe('meta');
  });

  it('passes null and non-finite compared values', () => {
    const g = gif({ views: null, likes: NaN, createDate: NaN });
    for (const f of ['views:>1m', 'favs:>1m', 'score:>50', 'age:<1h', 'date:2026-01-01']) {
      expect(checkGif(g, q(f), [], NOW)).toBeNull();
    }
  });

  it('skips required/any checks when tags are absent', () => {
    const g = gif({ tags: undefined as unknown as string[] });
    expect(checkGif(g, q('needed ~a ~b'), [], NOW)).toBeNull();
    expect(checkGif(g, q('-x --y'), parseBlacklist('z'), NOW)).toBeNull();
    expect(checkGif(g, q('views:>1m'), [], NOW)).toBe('meta');
  });
});

describe('sortPage', () => {
  const list = [
    gif({ id: 'a', views: 100, likes: 1, createDate: 300 }),
    gif({ id: 'b', views: 500, likes: 50, createDate: 100 }),
    gif({ id: 'c', views: null, likes: 5, createDate: 200 }),
    gif({ id: 'd', views: 300, likes: 3, createDate: 400 }),
  ];
  const ids = (gs: Gif[]) => gs.map((g) => g.id);

  it('sorts views both ways with unknowns last', () => {
    expect(ids(sortPage(list, 'views-desc'))).toEqual(['b', 'd', 'a', 'c']);
    expect(ids(sortPage(list, 'views-asc'))).toEqual(['a', 'd', 'b', 'c']);
  });

  it('sorts favs and date', () => {
    expect(ids(sortPage(list, 'favs-desc'))).toEqual(['b', 'c', 'd', 'a']);
    expect(ids(sortPage(list, 'favs-asc'))).toEqual(['a', 'd', 'c', 'b']);
    expect(ids(sortPage(list, 'date-asc'))).toEqual(['b', 'c', 'a', 'd']);
  });

  it('sorts by score with null scores last', () => {
    // scores: a 1/100 -> 55, b 50/500 -> 100, c null, d 3/300 -> 62
    expect(ids(sortPage(list, 'score-desc'))).toEqual(['b', 'd', 'a', 'c']);
    expect(ids(sortPage(list, 'score-asc'))).toEqual(['a', 'd', 'b', 'c']);
  });

  it('is stable for equal keys', () => {
    const same = ['x', 'y', 'z', 'w'].map((id) => gif({ id, views: 10 }));
    expect(ids(sortPage(same, 'views-desc'))).toEqual(['x', 'y', 'z', 'w']);
    expect(ids(sortPage(same, 'views-asc'))).toEqual(['x', 'y', 'z', 'w']);
  });

  it('keeps unknowns in original order and does not mutate input', () => {
    const unknowns = [
      gif({ id: 'u1', views: null }),
      gif({ id: 'k', views: 1 }),
      gif({ id: 'u2', views: NaN }),
    ];
    const before = ids(unknowns);
    expect(ids(sortPage(unknowns, 'views-desc'))).toEqual(['k', 'u1', 'u2']);
    expect(ids(sortPage(unknowns, 'views-asc'))).toEqual(['k', 'u1', 'u2']);
    expect(ids(unknowns)).toEqual(before);
  });
});
