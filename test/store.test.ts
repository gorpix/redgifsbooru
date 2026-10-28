import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBlacklistText, getPausedKeys, setBlacklistText, setPausedKeys, subscribeBlacklist } from '../src/store/blacklist';
import { getSavedSearches, removeSavedSearch, saveSearch, subscribeSaved } from '../src/store/saved';
import { MAX_SEEN, isSeen, markSeen, mergeSeen, subscribeSeen } from '../src/store/seen';
import { getSettings, subscribeSettings, updateSettings } from '../src/store/settings';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
  };
}

const throwing = {
  getItem: () => { throw new Error('blocked'); },
  setItem: () => { throw new Error('blocked'); },
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('settings', () => {
  it('stores showRelatedBelow and ignores non-booleans', () => {
    const storage = fakeStorage();
    expect(updateSettings({ showRelatedBelow: true }, storage).showRelatedBelow).toBe(true);
    expect(getSettings(storage).showRelatedBelow).toBe(true);
    expect(getSettings(fakeStorage({ 'rgb:settings': '{"showRelatedBelow":"yes"}' })).showRelatedBelow).toBe(false);
  });
  it('returns defaults for empty, garbage or blocked storage', () => {
    const defaults = { postsPerPage: 75, blacklistEnabled: true, showRelatedBelow: false, keepLoggedIn: true };
    expect(getSettings(fakeStorage())).toEqual(defaults);
    expect(getSettings(fakeStorage({ 'rgb:settings': '{oops' }))).toEqual(defaults);
    expect(getSettings(fakeStorage({ 'rgb:settings': '[1,2]' }))).toEqual(defaults);
    expect(getSettings(fakeStorage({ 'rgb:settings': JSON.stringify({ postsPerPage: 'x', blacklistEnabled: 1 }) }))).toEqual(defaults);
    expect(getSettings(throwing)).toEqual(defaults);
    expect(getSettings(null)).toEqual(defaults);
  });

  it('merges patches and persists', () => {
    const storage = fakeStorage();
    expect(updateSettings({ blacklistEnabled: false }, storage)).toEqual({ postsPerPage: 75, blacklistEnabled: false, showRelatedBelow: false, keepLoggedIn: true });
    updateSettings({ postsPerPage: 50 }, storage);
    expect(getSettings(storage)).toEqual({ postsPerPage: 50, blacklistEnabled: false, showRelatedBelow: false, keepLoggedIn: true });
    expect(JSON.parse(storage.data.get('rgb:settings')!)).toEqual(getSettings(storage));
  });

  it('does not throw when the write fails', () => {
    expect(() => updateSettings({ postsPerPage: 50 }, throwing)).not.toThrow();
  });

  it('notifies subscribers in this tab', () => {
    const fn = vi.fn();
    const off = subscribeSettings(fn);
    updateSettings({ postsPerPage: 50 }, fakeStorage());
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    updateSettings({ postsPerPage: 75 }, fakeStorage());
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('listens to the window storage event for its key only, and detaches on unsubscribe', () => {
    const win = new EventTarget();
    vi.stubGlobal('window', win);
    const fn = vi.fn();
    const off = subscribeSettings(fn);
    win.dispatchEvent(Object.assign(new Event('storage'), { key: 'rgb:settings' }));
    win.dispatchEvent(Object.assign(new Event('storage'), { key: 'other' }));
    win.dispatchEvent(Object.assign(new Event('storage'), { key: null }));
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    win.dispatchEvent(Object.assign(new Event('storage'), { key: 'rgb:settings' }));
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('blacklist store', () => {
  it('defaults to empty text and no paused keys', () => {
    const storage = fakeStorage();
    expect(getBlacklistText(storage)).toBe('');
    expect(getPausedKeys(storage)).toEqual([]);
    expect(getBlacklistText(throwing)).toBe('');
  });

  it('round-trips text and paused keys, ignoring garbage', () => {
    const storage = fakeStorage();
    setBlacklistText('a, *b\nc', storage);
    setPausedKeys(['exact:a', 'exact:a', 'partial:b'], storage);
    expect(getBlacklistText(storage)).toBe('a, *b\nc');
    expect(getPausedKeys(storage)).toEqual(['exact:a', 'partial:b']);
    storage.data.set('rgb:blacklist-paused', '{nope');
    expect(getPausedKeys(storage)).toEqual([]);
    storage.data.set('rgb:blacklist-paused', JSON.stringify(['x', 1, null, { a: 1 }]));
    expect(getPausedKeys(storage)).toEqual(['x']);
  });

  it('notifies on either key', () => {
    const fn = vi.fn();
    const off = subscribeBlacklist(fn);
    const storage = fakeStorage();
    setBlacklistText('a', storage);
    setPausedKeys(['k'], storage);
    expect(fn).toHaveBeenCalledTimes(2);
    off();
  });
});

describe('saved searches', () => {
  it('starts empty and tolerates garbage', () => {
    expect(getSavedSearches(fakeStorage())).toEqual([]);
    expect(getSavedSearches(fakeStorage({ 'rgb:saved-searches': 'nope' }))).toEqual([]);
    expect(getSavedSearches(fakeStorage({ 'rgb:saved-searches': JSON.stringify([{ name: 'a', query: 'b' }, 5, null, { name: 1, query: 'x' }, { name: 'n', query: ' ' }]) }))).toEqual([{ name: 'a', query: 'b' }]);
  });

  it('dedupes by query, replacing the name and moving it to the end', () => {
    const storage = fakeStorage();
    saveSearch('One', 'a b', storage);
    saveSearch('Two', 'c', storage);
    saveSearch('One again', 'a b', storage);
    expect(getSavedSearches(storage)).toEqual([{ name: 'Two', query: 'c' }, { name: 'One again', query: 'a b' }]);
  });

  it('uses the query as the name when the name is empty, and ignores an empty query', () => {
    const storage = fakeStorage();
    saveSearch('  ', 'x y', storage);
    saveSearch('Nothing', '  ', storage);
    expect(getSavedSearches(storage)).toEqual([{ name: 'x y', query: 'x y' }]);
  });

  it('removes by query and notifies', () => {
    const storage = fakeStorage();
    const fn = vi.fn();
    const off = subscribeSaved(fn);
    saveSearch('A', 'a', storage);
    saveSearch('B', 'b', storage);
    removeSavedSearch('a', storage);
    expect(getSavedSearches(storage)).toEqual([{ name: 'B', query: 'b' }]);
    expect(fn).toHaveBeenCalledTimes(3);
    off();
  });
});

describe('seen', () => {
  it('lowercases ids and reports seen ones', () => {
    const storage = fakeStorage();
    expect(isSeen('AbC', storage)).toBe(false);
    markSeen('AbC', storage);
    expect(isSeen('abc', storage)).toBe(true);
    expect(isSeen('ABC', storage)).toBe(true);
    expect(JSON.parse(storage.data.get('rgb:seen')!)).toEqual(['abc']);
  });

  it('does not duplicate ids', () => {
    const storage = fakeStorage();
    markSeen('a', storage);
    markSeen('A', storage);
    expect(JSON.parse(storage.data.get('rgb:seen')!)).toEqual(['a']);
  });

  it('keeps only the newest 5000', () => {
    const storage = fakeStorage();
    mergeSeen(Array.from({ length: MAX_SEEN + 20 }, (_, i) => `id${i}`), storage);
    const saved = JSON.parse(storage.data.get('rgb:seen')!);
    expect(saved).toHaveLength(5000);
    expect(saved[0]).toBe('id20');
    expect(saved.at(-1)).toBe(`id${MAX_SEEN + 19}`);
    expect(isSeen('id0', storage)).toBe(false);
    expect(isSeen('id20', storage)).toBe(true);
  });

  it('merges with what another tab wrote before each write', () => {
    const storage = fakeStorage();
    markSeen('a', storage);
    storage.data.set('rgb:seen', JSON.stringify(['a', 'other-tab']));
    markSeen('b', storage);
    expect(JSON.parse(storage.data.get('rgb:seen')!)).toEqual(['a', 'other-tab', 'b']);
    expect(isSeen('other-tab', storage)).toBe(true);
  });

  it('tolerates garbage and blocked storage', () => {
    expect(isSeen('a', fakeStorage({ 'rgb:seen': '{x' }))).toBe(false);
    const storage = fakeStorage({ 'rgb:seen': JSON.stringify(['a', 1, null]) });
    expect(isSeen('a', storage)).toBe(true);
    expect(() => markSeen('x', throwing)).not.toThrow();
    expect(() => isSeen('x', throwing)).not.toThrow();
  });

  it('notifies on new ids only', () => {
    const storage = fakeStorage();
    const fn = vi.fn();
    const off = subscribeSeen(fn);
    markSeen('a', storage);
    markSeen('a', storage);
    expect(fn).toHaveBeenCalledTimes(1);
    off();
  });
});
