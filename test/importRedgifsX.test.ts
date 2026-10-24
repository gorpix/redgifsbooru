import { describe, expect, it, vi } from 'vitest';
import { detectRedgifsX, importRedgifsX, redgifsXUrlToQuery } from '../src/store/importRedgifsX';
import { getBlacklistText, getPausedKeys, setBlacklistText, setPausedKeys } from '../src/store/blacklist';
import { getSavedSearches, saveSearch } from '../src/store/saved';
import { isSeen, markSeen } from '../src/store/seen';

function fakeStorage(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(initial).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
  };
}

const zeros = { blacklist: 0, paused: 0, saved: 0, skippedSaved: 0, seen: 0, tagCounts: 0 };
const url = (q: string) => `https://www.redgifs.com/browse?${q}`;

describe('redgifsXUrlToQuery', () => {
  it('converts each rg- key', () => {
    expect(redgifsXUrlToQuery(url('rg-tag=big%20tits&rg-tag=red_hair'))).toBe('big_tits red_hair');
    expect(redgifsXUrlToQuery(url('rg-tag=a&rg-exclude=big%20tits'))).toBe('a -big_tits');
    expect(redgifsXUrlToQuery(url('rg-tag=a&rg-exclude-contains=foo'))).toBe('a --foo');
    expect(redgifsXUrlToQuery(url('rg-tag=a&rg-any=b&rg-any=c%20d'))).toBe('a ~b ~c_d');
    expect(redgifsXUrlToQuery(url('rg-tag=a&rg-filter=views%3A%3E10k&rg-filter=age%3A%3C30d'))).toBe('a views:>10k age:<30d');
    expect(redgifsXUrlToQuery(url('rg-tag=a&rg-order=latest'))).toBe('a order:latest');
  });

  it('puts everything in booru order', () => {
    expect(redgifsXUrlToQuery(url('rg-order=top7&rg-any=z&rg-filter=favs%3A5&rg-exclude-contains=q&rg-exclude=e&rg-tag=t')))
      .toBe('t -e --q ~z favs:5 order:top7');
  });

  it('uses a query-only URL as one tag', () => {
    expect(redgifsXUrlToQuery('https://www.redgifs.com/browse?query=Big%20Tits')).toBe('big_tits');
    expect(redgifsXUrlToQuery('https://www.redgifs.com/search?query=a&rg-exclude=b')).toBe('a -b');
    // rg-tag wins over query
    expect(redgifsXUrlToQuery(url('query=zzz&rg-tag=a'))).toBe('a');
  });

  it('accepts relative URLs', () => {
    expect(redgifsXUrlToQuery('/browse?rg-tag=a')).toBe('a');
  });

  it('skips user pages and URLs with nothing convertible', () => {
    expect(redgifsXUrlToQuery('https://www.redgifs.com/users/someone?rg-tag=a')).toBeNull();
    expect(redgifsXUrlToQuery('https://www.redgifs.com/browse')).toBeNull();
    expect(redgifsXUrlToQuery(url('foo=bar&rg-tag='))).toBeNull();
  });
});

describe('detectRedgifsX / importRedgifsX', () => {
  it('returns zeros when nothing is present', () => {
    const storage = fakeStorage();
    const merge = vi.fn();
    expect(detectRedgifsX(storage)).toEqual(zeros);
    expect(importRedgifsX(storage, { merge })).toEqual(zeros);
    expect(detectRedgifsX(null)).toEqual(zeros);
    expect(importRedgifsX(null, { merge })).toEqual(zeros);
    expect(merge).not.toHaveBeenCalled();
    expect([...storage.data.keys()]).toEqual([]);
  });

  it('tolerates garbage values', () => {
    const storage = fakeStorage({
      'rg-view-sort:blacklist-disabled-v1': '{x',
      'rg-view-sort:saved-searches-v1': 'nope',
      'rg-view-sort:seen-v1': { a: 1 },
      'rg-view-sort:tag-counts-v1': [1, 2],
    });
    expect(detectRedgifsX(storage)).toEqual(zeros);
    expect(importRedgifsX(storage, { merge: vi.fn() })).toEqual(zeros);
  });

  const full = () => fakeStorage({
    'rg-view-sort:tag-blacklist-v1': 'foo, *bar\nbaz',
    'rg-view-sort:blacklist-disabled-v1': ['exact:foo', 'partial:bar'],
    'rg-view-sort:saved-searches-v1': [
      { name: 'Mine', url: url('rg-tag=a&rg-exclude=b') },
      { name: 'Creator', url: 'https://www.redgifs.com/users/x?rg-tag=a' },
      { name: 'Empty', url: 'https://www.redgifs.com/browse' },
      { name: 'Q', url: 'https://www.redgifs.com/browse?query=c%20d' },
    ],
    'rg-view-sort:seen-v1': ['ID1', 'id2'],
    'rg-view-sort:tag-counts-v1': { 'big tits': [5, 1234, ['Big Tits']], 'x': [null, 99, []] },
  });

  it('detects counts without changing anything', () => {
    const storage = full();
    const before = new Map(storage.data);
    expect(detectRedgifsX(storage)).toEqual({ blacklist: 3, paused: 2, saved: 2, skippedSaved: 2, seen: 2, tagCounts: 2 });
    expect(storage.data).toEqual(before);
  });

  it('imports every key into the booru keys and returns counts', () => {
    const storage = full();
    const merge = vi.fn();
    const result = importRedgifsX(storage, { merge });
    expect(result).toEqual({ blacklist: 3, paused: 2, saved: 2, skippedSaved: 2, seen: 2, tagCounts: 2 });
    expect(getBlacklistText(storage)).toBe('foo\n*bar\nbaz');
    expect(getPausedKeys(storage)).toEqual(['exact:foo', 'partial:bar']);
    expect(getSavedSearches(storage)).toEqual([{ name: 'Mine', query: 'a -b' }, { name: 'Q', query: 'c_d' }]);
    expect(isSeen('id1', storage)).toBe(true);
    expect(isSeen('id2', storage)).toBe(true);
    expect(merge).toHaveBeenCalledWith({ 'big tits': [5, 1234, ['Big Tits']], x: [null, 99, []] });
  });

  it('appends to the blacklist without duplicating entries, and unions the rest', () => {
    const storage = full();
    setBlacklistText('FOO\nqux', storage);
    setPausedKeys(['exact:foo', 'exact:other'], storage);
    saveSearch('Old', 'a -b', storage);
    markSeen('ID1', storage);
    markSeen('zzz', storage);
    const result = importRedgifsX(storage, null);
    expect(getBlacklistText(storage)).toBe('FOO\nqux\n*bar\nbaz');
    expect(result.blacklist).toBe(3 - 1);
    expect(getPausedKeys(storage)).toEqual(['exact:foo', 'exact:other', 'partial:bar']);
    expect(result.paused).toBe(1);
    // saved: duplicate query replaced and moved to the end
    expect(getSavedSearches(storage).map((s) => s.query)).toEqual(['a -b', 'c_d']);
    expect(result.seen).toBe(1);
    expect(JSON.parse(storage.data.get('rgb:seen')!)).toEqual(['id1', 'zzz', 'id2']);
  });

  it('importing twice adds nothing new to the blacklist or paused keys', () => {
    const storage = full();
    importRedgifsX(storage, null);
    const second = importRedgifsX(storage, null);
    expect(second.blacklist).toBe(0);
    expect(second.paused).toBe(0);
    expect(second.seen).toBe(0);
    expect(getBlacklistText(storage)).toBe('foo\n*bar\nbaz');
    expect(getSavedSearches(storage)).toHaveLength(2);
  });
});
