import { describe, expect, it } from 'vitest';
import { aliasBlacklist, applyAliases, buildAliasMap, resolveAlias } from '../src/search/aliases';
import { parseBlacklist } from '../src/search/match';
import { parseQuery } from '../src/search/query';

describe('buildAliasMap', () => {
  it('uses built-ins, user overrides, and self-mapping disables', () => {
    const map = buildAliasMap([['blond', 'blonde'], ['a', 'b']], [{ from: 'blond', to: 'fair' }, { from: 'a', to: 'a' }, { from: 'x', to: 'y' }]);
    expect(map.get('blond')).toBe('fair');
    expect(map.has('a')).toBe(false);
    expect(map.get('x')).toBe('y');
  });
});

describe('resolveAlias', () => {
  it('follows chains, caps hops, guards cycles', () => {
    expect(resolveAlias('a', new Map([['a', 'b'], ['b', 'c']]))).toBe('c');
    expect(resolveAlias('z', new Map())).toBe('z');
    const long = new Map([['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'f'], ['f', 'g'], ['g', 'h']]);
    expect(resolveAlias('a', long)).toBe('f');
    expect(resolveAlias('a', new Map([['a', 'b'], ['b', 'a']]))).toBe('b');
  });
});

describe('applyAliases', () => {
  const map = new Map([['blond', 'blonde'], ['readhead', 'redhead']]);
  it('rewrites required, any and exact exclusions; leaves partial alone', () => {
    const q = parseQuery('blond ~readhead -blond --blond cat');
    const { query, applied } = applyAliases(q, map);
    expect(query.required).toEqual(['blonde', 'cat']);
    expect(query.any).toEqual(['redhead']);
    expect(query.exclusions).toEqual([{ mode: 'exact', value: 'blonde' }, { mode: 'partial', value: 'blond' }]);
    expect(applied).toEqual([{ from: 'blond', to: 'blonde' }, { from: 'readhead', to: 'redhead' }]);
  });
  it('dedupes after rewriting and reports each rewrite once', () => {
    const { query, applied } = applyAliases(parseQuery('blond blonde -blond -blonde'), map);
    expect(query.required).toEqual(['blonde']);
    expect(query.exclusions).toEqual([{ mode: 'exact', value: 'blonde' }]);
    expect(applied).toEqual([{ from: 'blond', to: 'blonde' }]);
  });
  it('does nothing without matches', () => {
    expect(applyAliases(parseQuery('cat'), map).applied).toEqual([]);
  });
});

describe('aliasBlacklist', () => {
  it('rewrites exact rules, recomputes keys, dedupes, keeps partial', () => {
    const map = new Map([['blond', 'blonde']]);
    const out = aliasBlacklist(parseBlacklist('blond, blonde, *blond, cat'), map);
    expect(out.map((r) => r.key)).toEqual(['exact:blonde', 'partial:blond', 'exact:cat']);
  });
});
