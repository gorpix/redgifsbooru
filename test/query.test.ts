import { describe, expect, it } from 'vitest';
import { toTagTerm, normalizeTag } from '../src/search/tags';
import { formatQuery, parseMetaFilter, parseQuery, queryKey } from '../src/search/query';

const localSeconds = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime() / 1000;

describe('parseQuery tokens', () => {
  it('parses an empty query to defaults', () => {
    expect(parseQuery('')).toEqual({
      required: [],
      any: [],
      exclusions: [],
      meta: [],
      serverOrder: 'trending',
      pageSort: null,
      type: 'g',
    });
  });

  it('parses required, excludes, partial excludes and any-group', () => {
    const q = parseQuery('Big_Tits blonde -anal --feet ~a ~b');
    expect(q.required).toEqual(['big tits', 'blonde']);
    expect(q.exclusions).toEqual([
      { mode: 'exact', value: 'anal' },
      { mode: 'partial', value: 'feet' },
    ]);
    expect(q.any).toEqual(['a', 'b']);
  });

  it('supports quoted tags with and without prefixes', () => {
    const q = parseQuery('"big tits" -"hot dog" --"foo bar" ~"x y"');
    expect(q.required).toEqual(['big tits']);
    expect(q.exclusions).toEqual([
      { mode: 'exact', value: 'hot dog' },
      { mode: 'partial', value: 'foo bar' },
    ]);
    expect(q.any).toEqual(['x y']);
  });

  it('skips prefix tokens that normalize to empty', () => {
    const q = parseQuery('-"  " ~"  " a');
    expect(q.required).toEqual(['a']);
    expect(q.exclusions).toEqual([]);
    expect(q.any).toEqual([]);
  });

  it('de-duplicates', () => {
    const q = parseQuery('a A a_ -x -X --x --x ~b ~B views:>1k views:>1K');
    expect(q.required).toEqual(['a']);
    expect(q.exclusions).toEqual([
      { mode: 'exact', value: 'x' },
      { mode: 'partial', value: 'x' },
    ]);
    expect(q.any).toEqual(['b']);
    expect(q.meta).toHaveLength(1);
  });

  it('treats a prefixed meta token as an exact exclude of that text', () => {
    const q = parseQuery('-views:>10k');
    expect(q.meta).toEqual([]);
    expect(q.exclusions).toEqual([{ mode: 'exact', value: 'views:>10k' }]);
  });

  it('treats quoted directives as plain tags', () => {
    const q = parseQuery('"views:>10k" "order:latest" "type:image"');
    expect(q.required).toEqual(['views:>10k', 'order:latest', 'type:image']);
    expect(q.meta).toEqual([]);
    expect(q.serverOrder).toBe('trending');
    expect(q.type).toBe('g');
  });

  it('turns invalid meta tokens into plain required tags', () => {
    const q = parseQuery('views:abc age:2026-01-01 favs:5..x score:');
    expect(q.required).toEqual(['views:abc', 'age:2026 01 01', 'favs:5..x', 'score:']);
    expect(q.meta).toEqual([]);
  });
});

describe('orders and type', () => {
  it('maps server order aliases case-insensitively', () => {
    for (const [alias, order] of [
      ['latest', 'latest'],
      ['new', 'latest'],
      ['NEWEST', 'latest'],
      ['date', 'latest'],
      ['recent', 'latest'],
      ['top7', 'top7'],
      ['Week', 'top7'],
      ['top28', 'top28'],
      ['month', 'top28'],
      ['trending', 'trending'],
    ] as const) {
      expect(parseQuery(`order:${alias}`).serverOrder).toBe(order);
    }
  });

  it('maps page sort aliases', () => {
    for (const [alias, sort] of [
      ['views', 'views-desc'],
      ['views_desc', 'views-desc'],
      ['views_asc', 'views-asc'],
      ['score', 'score-desc'],
      ['score_desc', 'score-desc'],
      ['score_asc', 'score-asc'],
      ['favs', 'favs-desc'],
      ['favs_desc', 'favs-desc'],
      ['likes', 'favs-desc'],
      ['favs_asc', 'favs-asc'],
      ['date_asc', 'date-asc'],
      ['old', 'date-asc'],
      ['OLDEST', 'date-asc'],
    ] as const) {
      expect(parseQuery(`order:${alias}`).pageSort).toBe(sort);
    }
  });

  it('keeps one server order and one page sort, last wins', () => {
    const q = parseQuery('order:latest order:week order:views order:score_asc');
    expect(q.serverOrder).toBe('top7');
    expect(q.pageSort).toBe('score-asc');
  });

  it('lets unknown orders fall through to tags', () => {
    const q = parseQuery('order:bogus');
    expect(q.required).toEqual(['order:bogus']);
    expect(q.serverOrder).toBe('trending');
    expect(q.pageSort).toBeNull();
  });

  it('maps type values, last wins', () => {
    expect(parseQuery('type:video').type).toBe('g');
    expect(parseQuery('type:GIF').type).toBe('g');
    expect(parseQuery('type:g').type).toBe('g');
    expect(parseQuery('type:image').type).toBe('i');
    expect(parseQuery('type:images').type).toBe('i');
    expect(parseQuery('type:i').type).toBe('i');
    expect(parseQuery('type:image type:video').type).toBe('g');
    expect(parseQuery('type:video type:i').type).toBe('i');
  });

  it('lets unknown types fall through to tags', () => {
    const q = parseQuery('type:audio');
    expect(q.required).toEqual(['type:audio']);
    expect(q.type).toBe('g');
  });

  it('does not recognize prefixed order or type', () => {
    const q = parseQuery('-order:latest ~type:image');
    expect(q.serverOrder).toBe('trending');
    expect(q.type).toBe('g');
    expect(q.exclusions).toEqual([{ mode: 'exact', value: 'order:latest' }]);
    expect(q.any).toEqual(['type:image']);
  });
});

describe('parseMetaFilter', () => {
  const num = (field: string, raw: string, min: number, max: number, minI: boolean, maxI: boolean) => {
    const f = parseMetaFilter(`${field}:${raw}`)!;
    expect(f).not.toBeNull();
    expect(f.kind).toBe('number');
    expect([f.min, f.max, f.minInclusive, f.maxInclusive]).toEqual([min, max, minI, maxI]);
    return f;
  };

  it('parses number operators', () => {
    num('views', '5', 5, 5, true, true);
    num('views', '>5', 5, Infinity, false, false);
    num('views', '>=5', 5, Infinity, true, false);
    num('views', '<5', -Infinity, 5, false, false);
    num('views', '<=5', -Infinity, 5, false, true);
  });

  it('parses k/m suffixes and decimals', () => {
    num('views', '>10k', 10_000, Infinity, false, false);
    num('views', '>=1.5K', 1500, Infinity, true, false);
    num('views', '<2m', -Infinity, 2_000_000, false, false);
    num('views', '0.5m', 500_000, 500_000, true, true);
  });

  it('parses ranges with open sides', () => {
    num('views', '1k..5k', 1000, 5000, true, true);
    num('views', '1k..', 1000, Infinity, true, true);
    num('views', '..5k', -Infinity, 5000, true, true);
  });

  it('rejects operators with ranges, empty ranges and bad sides', () => {
    expect(parseMetaFilter('views:>1k..5k')).toBeNull();
    expect(parseMetaFilter('views:..')).toBeNull();
    expect(parseMetaFilter('views:1k..x')).toBeNull();
    expect(parseMetaFilter('views:abc')).toBeNull();
    expect(parseMetaFilter('views:>')).toBeNull();
    expect(parseMetaFilter('views:5d')).toBeNull();
    expect(parseMetaFilter('hello:5')).toBeNull();
    expect(parseMetaFilter('views')).toBeNull();
  });

  it('maps favorites and likes to favs and keeps the typed label', () => {
    const a = parseMetaFilter('Favorites:>=10K')!;
    expect(a.field).toBe('favs');
    expect(a.label).toBe('favorites:>=10k');
    expect(parseMetaFilter('likes:5')!.field).toBe('favs');
    expect(parseMetaFilter('score:>50')!.field).toBe('score');
  });

  it('parses each age unit', () => {
    const units: [string, number][] = [
      ['2h', 7200],
      ['3d', 3 * 86400],
      ['2w', 2 * 604800],
      ['6mo', 6 * 2592000],
      ['1y', 31536000],
    ];
    for (const [raw, seconds] of units) {
      const f = parseMetaFilter(`age:<${raw}`)!;
      expect(f.kind).toBe('age');
      expect([f.min, f.max, f.minInclusive, f.maxInclusive]).toEqual([-Infinity, seconds, false, false]);
    }
  });

  it('parses age equals as within, ranges and operators', () => {
    const eq = parseMetaFilter('age:30d')!;
    expect([eq.min, eq.max, eq.minInclusive, eq.maxInclusive]).toEqual([0, 30 * 86400, true, true]);
    const gt = parseMetaFilter('age:>1y')!;
    expect([gt.min, gt.max, gt.minInclusive]).toEqual([31536000, Infinity, false]);
    const range = parseMetaFilter('age:1d..1w')!;
    expect([range.min, range.max]).toEqual([86400, 604800]);
  });

  it('parses a date as a local-midnight day window', () => {
    const d = localSeconds(2026, 1, 15);
    const f = parseMetaFilter('date:2026-01-15')!;
    expect(f.kind).toBe('date');
    expect([f.min, f.max, f.minInclusive, f.maxInclusive]).toEqual([d, d + 86400, true, false]);
  });

  it('parses date operators and ranges', () => {
    const d = localSeconds(2026, 1, 1);
    const gt = parseMetaFilter('date:>2026-01-01')!;
    expect([gt.min, gt.max, gt.minInclusive]).toEqual([d, Infinity, false]);
    const le = parseMetaFilter('date:<=2026-01-01')!;
    expect([le.min, le.max, le.maxInclusive]).toEqual([-Infinity, d, true]);
    const e = localSeconds(2026, 2, 1);
    const range = parseMetaFilter('date:2026-01-01..2026-02-01')!;
    expect([range.min, range.max, range.minInclusive, range.maxInclusive]).toEqual([d, e, true, true]);
    const open = parseMetaFilter('date:2026-01-01..')!;
    expect([open.min, open.max]).toEqual([d, Infinity]);
  });

  it('treats date with an age value as an age filter', () => {
    const f = parseMetaFilter('date:7d')!;
    expect(f.field).toBe('date');
    expect(f.kind).toBe('age');
    expect([f.min, f.max]).toEqual([0, 7 * 86400]);
    expect(f.label).toBe('date:7d');
  });

  it('rejects impossible dates, mixed ranges and age with a date', () => {
    expect(parseMetaFilter('date:2026-02-31')).toBeNull();
    expect(parseMetaFilter('date:2026-13-01')).toBeNull();
    expect(parseMetaFilter('date:2026-01-01..7d')).toBeNull();
    expect(parseMetaFilter('age:2026-01-01')).toBeNull();
    expect(parseMetaFilter('date:5')).toBeNull();
  });
});

describe('formatQuery and queryKey', () => {
  it('prints the canonical form', () => {
    const q = parseQuery('Big_Tits blonde -anal --feet ~a ~b views:>10k order:week order:views type:image');
    expect(formatQuery(q)).toBe(
      'big_tits blonde -anal --feet ~a ~b views:>10k type:image order:top7 order:views',
    );
  });

  it('omits defaults', () => {
    expect(formatQuery(parseQuery('a order:trending type:g'))).toBe('a');
    expect(formatQuery(parseQuery(''))).toBe('');
  });

  it('prints the first alias of every order', () => {
    expect(formatQuery(parseQuery('order:new'))).toBe('order:latest');
    expect(formatQuery(parseQuery('order:month'))).toBe('order:top28');
    for (const [input, name] of [
      ['likes', 'favs'],
      ['favs_asc', 'favs_asc'],
      ['score_desc', 'score'],
      ['score_asc', 'score_asc'],
      ['views_desc', 'views'],
      ['views_asc', 'views_asc'],
      ['oldest', 'date_asc'],
    ]) {
      expect(formatQuery(parseQuery(`order:${input}`))).toBe(`order:${name}`);
    }
  });

  it('round-trips', () => {
    const inputs = [
      'Big_Tits blonde -anal --feet ~a ~b views:>10k order:week order:views type:image',
      '"big tits" -"hot dog" --"foo bar" ~"x y" age:<30d date:2026-01-01..2026-02-01 favorites:5..',
      'views:abc order:bogus type:audio date:7d score:>=50 order:oldest order:latest',
      '',
    ];
    for (const input of inputs) {
      const once = formatQuery(parseQuery(input));
      expect(formatQuery(parseQuery(once))).toBe(once);
      expect(parseQuery(once)).toEqual(parseQuery(once));
    }
  });

  it('queryKey is stable under reordering', () => {
    const a = parseQuery('b a -y --x ~q ~p views:>1k age:<7d');
    const b = parseQuery('a b --x -y ~p ~q age:<7d views:>1k');
    expect(queryKey(a)).toBe(queryKey(b));
    expect(queryKey(a)).toBe('a b --x -y ~p ~q age:<7d views:>1k');
  });

  it('queryKey differs for different queries', () => {
    expect(queryKey(parseQuery('a'))).not.toBe(queryKey(parseQuery('a type:image')));
    expect(queryKey(parseQuery('a'))).not.toBe(queryKey(parseQuery('a order:latest')));
    expect(queryKey(parseQuery('a'))).not.toBe(queryKey(parseQuery('a order:views')));
  });
});

describe('hyphens are spaces', () => {
  it('normalizeTag and toTagTerm treat hyphens like underscores', () => {
    expect(normalizeTag('Step-Mom')).toBe('step mom');
    expect(toTagTerm('T-Shirt')).toBe('t_shirt');
    expect(toTagTerm('Step-Mom')).toBe('step_mom');
    expect(normalizeTag('-')).toBe('');
  });

  it('parses prefixes before normalizing', () => {
    expect(parseQuery('-step-mom').exclusions).toEqual([{ mode: 'exact', value: 'step mom' }]);
    expect(parseQuery('--t-shirt').exclusions).toEqual([{ mode: 'partial', value: 't shirt' }]);
    expect(parseQuery('step-mom').required).toEqual(['step mom']);
    expect(parseQuery('a - b').required).toEqual(['a', 'b']);
  });
});
