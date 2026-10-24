import { describe, expect, it } from 'vitest';
import type { Gif } from '../src/api/types';
import { checkGif, parseBlacklist } from '../src/search/match';
import { applyMerges, buildMergeIndex, mergeBlacklist, parseMergeText, reorderMergeText } from '../src/search/merges';
import { parseQuery } from '../src/search/query';
import { serverStreams } from '../src/search/server';
import { getMergeText, setMergeText, subscribeMerges } from '../src/store/merges';

const NOW = 1_800_000_000;
const builtin = [['big tits', 'big boobs'], ['tits', 'boobs', 'breasts']];

function gif(tags: string[]): Gif {
  return {
    id: 'a', userName: 'u', createDate: NOW - 100, views: 1, likes: 0, duration: 1, width: 1, height: 1,
    hasAudio: false, type: 1, tags, niches: [], description: null, verified: false, urls: {},
  };
}

describe('parseMergeText', () => {
  it('splits on commas, normalizes, skips blanks and comments, keeps single keys', () => {
    expect(parseMergeText('Big_Boobs, big tits\n\n# note\n  tits ,boobs,tits\nsolo\n,,')).toEqual([
      ['big boobs', 'big tits'],
      ['tits', 'boobs'],
      ['solo'],
    ]);
  });
});

describe('buildMergeIndex', () => {
  it('maps members to the first key and is identity elsewhere', () => {
    const index = buildMergeIndex(builtin, []);
    expect(index.canonical('big boobs')).toBe('big tits');
    expect(index.canonical('big tits')).toBe('big tits');
    expect(index.canonical('blonde')).toBe('blonde');
    expect(index.members('boobs')).toEqual(['tits', 'boobs', 'breasts']);
    expect(index.members('blonde')).toEqual(['blonde']);
  });

  it('members returns a copy', () => {
    const index = buildMergeIndex(builtin, []);
    index.members('tits').push('x');
    expect(index.members('tits')).toEqual(['tits', 'boobs', 'breasts']);
  });

  it('a user group sharing any key drops the whole built-in group', () => {
    const index = buildMergeIndex(builtin, [['boobs', 'jugs']]);
    expect(index.members('boobs')).toEqual(['boobs', 'jugs']);
    expect(index.canonical('tits')).toBe('tits');
    expect(index.canonical('breasts')).toBe('breasts');
    expect(index.canonical('big boobs')).toBe('big tits'); // other group untouched
  });

  it('a single-key user line un-merges that key; a group left with one key disappears', () => {
    const one = buildMergeIndex(builtin, [['breasts']]);
    expect(one.members('tits')).toEqual(['tits', 'boobs']);
    expect(one.canonical('breasts')).toBe('breasts');
    const two = buildMergeIndex(builtin, [['big boobs']]);
    expect(two.canonical('big boobs')).toBe('big boobs');
    expect(two.members('big tits')).toEqual(['big tits']);
  });

  it('puts every key in at most one group when user groups overlap', () => {
    const index = buildMergeIndex([], [['a', 'b'], ['b', 'c'], ['c', 'd']]);
    expect(index.members('a')).toEqual(['a', 'b']);
    expect(index.members('c')).toEqual(['c', 'd']);
    expect(index.canonical('b')).toBe('a');
  });
});

describe('applyMerges', () => {
  const index = buildMergeIndex(builtin, []);

  it('rewrites required, any and exact exclusions; dedupes; reports applied', () => {
    const q = parseQuery('big_boobs big_tits ~boobs ~tits -big_boobs --boob blonde');
    const { query, applied } = applyMerges(q, index);
    expect(query.required).toEqual(['big tits', 'blonde']);
    expect(query.any).toEqual(['tits']);
    expect(query.exclusions).toEqual([{ mode: 'exact', value: 'big tits' }, { mode: 'partial', value: 'boob' }]);
    expect(applied).toEqual([{ from: 'big boobs', to: 'big tits' }, { from: 'boobs', to: 'tits' }]);
  });

  it('leaves unmerged queries alone', () => {
    const q = parseQuery('blonde -anal');
    const { query, applied } = applyMerges(q, index);
    expect(query).toEqual(q);
    expect(applied).toEqual([]);
  });
});

describe('mergeBlacklist', () => {
  const index = buildMergeIndex(builtin, []);
  it('expands exact rules to every member, keeps partial rules, dedupes', () => {
    const rules = parseBlacklist('boobs, *boob, tits, anal');
    expect(mergeBlacklist(rules, index).map((r) => r.key)).toEqual([
      'exact:tits', 'exact:boobs', 'exact:breasts', 'partial:boob', 'exact:anal',
    ]);
  });
});

describe('checkGif with a merge index', () => {
  const index = buildMergeIndex(builtin, []);
  const q = (t: string) => applyMerges(parseQuery(t), index).query;

  it('treats merged tags as their canonical key', () => {
    expect(checkGif(gif(['Big Boobs']), q('big_tits'), [], NOW, index)).toBeNull();
    expect(checkGif(gif(['Big Boobs']), q('big_tits'), [], NOW)).toBe('required');
    expect(checkGif(gif(['Boobs']), q('~tits ~anal'), [], NOW, index)).toBeNull();
    expect(checkGif(gif(['Big Boobs']), q('-big_tits'), [], NOW, index)).toBe('exclude');
    expect(checkGif(gif(['Big Boobs']), q('-big_boobs'), [], NOW, index)).toBe('exclude');
  });

  it('applies exact blacklist rules through the index but partial ones to raw keys', () => {
    const rules = mergeBlacklist(parseBlacklist('boobs'), index);
    expect(checkGif(gif(['Tits']), q(''), rules, NOW, index)).toBe('blacklist');
    const partial = parseBlacklist('*boobs');
    expect(checkGif(gif(['Big Boobs']), q(''), partial, NOW, index)).toBe('blacklist');
    expect(checkGif(gif(['Tits']), q(''), partial, NOW, index)).toBeNull();
  });

  it('without the index nothing changes', () => {
    expect(checkGif(gif(['Boobs']), parseQuery('tits'), [], NOW)).toBe('required');
  });
});

describe('serverStreams', () => {
  const index = buildMergeIndex([['a1', 'a2'], ['b1', 'b2', 'b3']], []);
  const name = (k: string) => k.toUpperCase();

  it('is the cartesian product in popularity order, first tag varying slowest', () => {
    expect(serverStreams(parseQuery('a1 c'), index, name)).toEqual([['A1', 'C'], ['A2', 'C']]);
    expect(serverStreams(parseQuery('a1 b1'), index, name, 10)).toEqual([
      ['A1', 'B1'], ['A1', 'B2'], ['A1', 'B3'], ['A2', 'B1'], ['A2', 'B2'], ['A2', 'B3'],
    ]);
  });

  it('caps at four streams by default, keeping product order', () => {
    expect(serverStreams(parseQuery('a1 b1'), index, name)).toEqual([
      ['A1', 'B1'], ['A1', 'B2'], ['A1', 'B3'], ['A2', 'B1'],
    ]);
  });

  it('returns a single undefined stream without required tags', () => {
    expect(serverStreams(parseQuery('~a1 -b1'), index, name)).toEqual([undefined]);
  });

  it('gives one stream for an unmerged query', () => {
    expect(serverStreams(parseQuery('x y'), index, name)).toEqual([['X', 'Y']]);
  });
});

describe('reorderMergeText', () => {
  it('sorts each line by count desc, unknown last, ties keep typed order, keeps comments', () => {
    const counts: Record<string, number | null> = { 'big boobs': 5000, 'big tits': 9000, a: 10, b: 10, z: null };
    const out = reorderMergeText('big_boobs, big_tits\n# keep\nz, b, a, q\n\nsolo', (k) => counts[k]);
    expect(out).toBe('big_tits, big_boobs\n# keep\nb, a, z, q\n\nsolo');
  });
});

describe('merge store', () => {
  it('round-trips text and notifies', () => {
    const data = new Map<string, string>();
    const s = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
    let calls = 0;
    const off = subscribeMerges(() => { calls++; });
    expect(getMergeText(s)).toBe('');
    setMergeText('a, b', s);
    expect(getMergeText(s)).toBe('a, b');
    expect(calls).toBe(1);
    off();
    expect(getMergeText({ getItem: () => { throw new Error('x'); }, setItem: () => undefined })).toBe('');
  });
});
