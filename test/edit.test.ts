import { describe, expect, it } from 'vitest';
import { addTagToQuery, excludeTagFromQuery, replaceTagInQuery } from '../src/search/edit';

describe('addTagToQuery', () => {
  it('adds a required tag to an empty query', () => {
    expect(addTagToQuery('', 'Big Tits')).toBe('big_tits');
  });

  it('does not duplicate an existing tag', () => {
    expect(addTagToQuery('blonde', 'blonde')).toBe('blonde');
  });

  it('removes an exact exclusion of the tag', () => {
    expect(addTagToQuery('-blonde teen', 'blonde')).toBe('teen blonde');
  });

  it('keeps partial exclusions and other terms', () => {
    expect(addTagToQuery('--blon order:latest', 'blonde')).toBe('blonde --blon order:latest');
  });
});

describe('excludeTagFromQuery', () => {
  it('removes the tag from required and any, and excludes it', () => {
    expect(excludeTagFromQuery('blonde ~blonde ~teen', 'blonde')).toBe('-blonde ~teen');
  });

  it('does not duplicate an exclusion', () => {
    expect(excludeTagFromQuery('-blonde', 'Blonde')).toBe('-blonde');
  });

  it('works on an empty query', () => {
    expect(excludeTagFromQuery('', 'big tits')).toBe('-big_tits');
  });
});

describe('replaceTagInQuery', () => {
  it('replaces in required, any and exclusions', () => {
    expect(replaceTagInQuery('big_tits_x -big_tits_x ~big_tits_x ~a', 'big_tits_x', 'big_tits')).toBe('big_tits -big_tits ~big_tits ~a');
  });

  it('merges with an existing term', () => {
    expect(replaceTagInQuery('a_b a', 'a_b', 'a')).toBe('a');
  });

  it('leaves partial exclusion modes intact', () => {
    expect(replaceTagInQuery('--abc x', 'abc', 'abd')).toBe('x --abd');
  });

  it('is a no-op for an unknown tag', () => {
    expect(replaceTagInQuery('x y', 'z', 'w')).toBe('x y');
  });
});
