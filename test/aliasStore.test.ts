import { describe, expect, it, vi } from 'vitest';
import { addUserAlias, getAliasText, parseAliasText, setAliasText, subscribeAliases } from '../src/store/aliases';

function fakeStorage() {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
}
const throwing = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };

describe('alias store', () => {
  it('parses -> and =>, skips comments, blanks and invalid lines, normalizes', () => {
    expect(parseAliasText('Blond -> Blonde\n\n# note\nbig_tits => Big Tits\nno separator\n-> x\ny ->\nfoo bar')).toEqual([
      { from: 'blond', to: 'blonde' },
      { from: 'big tits', to: 'big tits' },
    ]);
  });
  it('round-trips text and tolerates blocked storage', () => {
    const s = fakeStorage();
    expect(getAliasText(s)).toBe('');
    setAliasText('a -> b', s);
    expect(getAliasText(s)).toBe('a -> b');
    expect(getAliasText(throwing)).toBe('');
    expect(() => setAliasText('a', throwing)).not.toThrow();
  });
  it('addUserAlias appends or replaces the line for from, and notifies', () => {
    const s = fakeStorage();
    const fn = vi.fn();
    const off = subscribeAliases(fn);
    addUserAlias('Blond', 'blonde', s);
    addUserAlias('x', 'y', s);
    expect(getAliasText(s)).toBe('blond -> blonde\nx -> y');
    addUserAlias('blond', 'fair hair', s);
    expect(getAliasText(s)).toBe('blond -> fair_hair\nx -> y');
    expect(fn).toHaveBeenCalledTimes(3);
    off();
  });
});
