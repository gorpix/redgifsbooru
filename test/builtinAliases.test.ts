import { describe, expect, it } from 'vitest';
import { BUILTIN_ALIASES } from '../src/search/builtinAliases';
import { normalizeTag } from '../src/search/tags';

describe('BUILTIN_ALIASES', () => {
  it('has a useful number of entries', () => {
    expect(BUILTIN_ALIASES.length).toBeGreaterThan(30);
  });

  it('has no empty strings and only normalized keys', () => {
    for (const [from, to] of BUILTIN_ALIASES) {
      expect(from).not.toBe('');
      expect(to).not.toBe('');
      expect(normalizeTag(from)).toBe(from);
      expect(normalizeTag(to)).toBe(to);
    }
  });

  it('has unique sources', () => {
    const sources = BUILTIN_ALIASES.map(([from]) => from);
    expect(new Set(sources).size).toBe(sources.length);
  });

  it('never maps a word to itself and has no chains', () => {
    const sources = new Set(BUILTIN_ALIASES.map(([from]) => from));
    for (const [from, to] of BUILTIN_ALIASES) {
      expect(to).not.toBe(from);
      expect(sources.has(to)).toBe(false);
    }
  });

  it('is sorted by source', () => {
    const sources = BUILTIN_ALIASES.map(([from]) => from);
    expect(sources).toEqual([...sources].sort());
  });
});
