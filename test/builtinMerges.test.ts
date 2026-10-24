import { describe, expect, it } from 'vitest';
import { BUILTIN_MERGES } from '../src/search/builtinMerges';
import { BUILTIN_ALIASES } from '../src/search/builtinAliases';
import { normalizeTag } from '../src/search/tags';

describe('BUILTIN_MERGES', () => {
  it('has at least 20 groups', () => {
    expect(BUILTIN_MERGES.length).toBeGreaterThanOrEqual(20);
  });
  it('every group has >= 2 distinct keys', () => {
    for (const g of BUILTIN_MERGES) {
      expect(g.length).toBeGreaterThanOrEqual(2);
      expect(new Set(g).size).toBe(g.length);
    }
  });
  it('every key is normalized', () => {
    for (const g of BUILTIN_MERGES) for (const k of g) expect(normalizeTag(k)).toBe(k);
  });
  it('no key is in two groups', () => {
    const seen = new Set<string>();
    for (const g of BUILTIN_MERGES)
      for (const k of g) {
        expect(seen.has(k), k).toBe(false);
        seen.add(k);
      }
  });
  it('no key is an alias source', () => {
    const sources = new Set(BUILTIN_ALIASES.map(([from]) => normalizeTag(from)));
    for (const g of BUILTIN_MERGES) for (const k of g) expect(sources.has(k), k).toBe(false);
  });
});
