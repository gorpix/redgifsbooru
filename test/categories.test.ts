import { describe, expect, it } from 'vitest';
import { BUILTIN_CATEGORIES } from '../src/search/builtinCategories';
import { BUILTIN_MERGES } from '../src/search/builtinMerges';
import {
  CATEGORIES, CATEGORY_COLOR, CATEGORY_LABEL, CATEGORY_ORDER, categoryOf, isCategory, parseCategoryText,
} from '../src/search/categories';
import { buildMergeIndex } from '../src/search/merges';
import { normalizeTag } from '../src/search/tags';
import { CATEGORIES_KEY, getCategoryText, setCategoryText, subscribeCategories } from '../src/store/categories';

describe('constants', () => {
  it('have a label and colour for every category', () => {
    for (const c of CATEGORIES) {
      expect(CATEGORY_LABEL[c]).toBeTruthy();
      expect(CATEGORY_COLOR[c]).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(CATEGORY_COLOR.creator).toBe('#f2ac08');
  });
  it('orders the sidebar groups', () => {
    expect(CATEGORY_ORDER).toEqual(['body', 'act', 'setting', 'general', 'meta']);
  });
});

describe('BUILTIN_CATEGORIES', () => {
  const entries = Object.entries(BUILTIN_CATEGORIES);
  it('has a few hundred entries', () => {
    expect(entries.length).toBeGreaterThanOrEqual(200);
    expect(entries.length).toBeLessThanOrEqual(800);
  });
  it('has normalized keys', () => {
    for (const [key] of entries) expect(key).toBe(normalizeTag(key));
  });
  it('has valid values, and never lists general', () => {
    for (const [key, value] of entries) {
      expect(isCategory(value), key).toBe(true);
      expect(value, key).not.toBe('general');
      expect(value, key).not.toBe('creator');
    }
  });
  it('categorizes well-known tags', () => {
    expect(BUILTIN_CATEGORIES['big tits']).toBe('body');
    expect(BUILTIN_CATEGORIES['blowjob']).toBe('act');
    expect(BUILTIN_CATEGORIES['outdoor']).toBe('setting');
    expect(BUILTIN_CATEGORIES['onlyfans']).toBe('meta');
  });
  it('is consistent across merge groups (members share the canonical tag category when both are listed)', () => {
    const index = buildMergeIndex(BUILTIN_MERGES, []);
    for (const [key, value] of entries) {
      const canonical = index.canonical(key);
      if (canonical !== key && canonical in BUILTIN_CATEGORIES) expect(BUILTIN_CATEGORIES[canonical], key).toBe(value);
    }
  });
});

describe('parseCategoryText', () => {
  it('parses lines, normalizing tags and categories', () => {
    const parsed = parseCategoryText('Big_Tits: Body\n  red-hair :ACT \n# comment\n\nnonsense\nfoo: bogus\n: act\nbar: general');
    expect({ ...parsed }).toEqual({ 'big tits': 'body', 'red hair': 'act', bar: 'general' });
  });
  it('lets a later line win and tolerates CRLF and non-strings', () => {
    expect({ ...parseCategoryText('a: act\r\na: meta') }).toEqual({ a: 'meta' });
    expect({ ...parseCategoryText(undefined as unknown as string) }).toEqual({});
  });
});

describe('categoryOf', () => {
  const builtin = { 'big tits': 'body', blowjob: 'act', tits: 'body' } as const;
  const index = buildMergeIndex([['tits', 'boobs']], []);
  it('defaults to general', () => {
    expect(categoryOf('mystery', builtin, {})).toBe('general');
  });
  it('normalizes the key', () => {
    expect(categoryOf('Big_Tits', builtin, {})).toBe('body');
  });
  it('lets the user win', () => {
    expect(categoryOf('blowjob', builtin, { blowjob: 'meta' })).toBe('meta');
  });
  it('uses the merge-canonical key', () => {
    expect(categoryOf('boobs', builtin, {}, index)).toBe('body');
    expect(categoryOf('boobs', builtin, {})).toBe('general');
    expect(categoryOf('boobs', builtin, { tits: 'meta' }, index)).toBe('meta');
    expect(categoryOf('boobs', builtin, { boobs: 'act' }, index)).toBe('act');
  });
  it('is not fooled by object prototype names', () => {
    expect(categoryOf('constructor', builtin, {})).toBe('general');
    expect(categoryOf('toString', builtin, {})).toBe('general');
  });
});

describe('category store', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  };
  it('round-trips the raw text under its key', () => {
    const storage = memory();
    expect(getCategoryText(storage)).toBe('');
    setCategoryText('a: act', storage);
    expect(getCategoryText(storage)).toBe('a: act');
    expect(storage.getItem(CATEGORIES_KEY)).toBe('a: act');
  });
  it('notifies subscribers', () => {
    let calls = 0;
    const off = subscribeCategories(() => { calls++; });
    setCategoryText('x: meta', memory());
    off();
    setCategoryText('y: meta', memory());
    expect(calls).toBe(1);
  });
});
