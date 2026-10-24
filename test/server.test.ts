import { describe, expect, it } from 'vitest';
import { parseQuery } from '../src/search/query';
import { serverParams } from '../src/search/server';

describe('serverParams', () => {
  it('uses the required keys when there is no canonical map', () => {
    expect(serverParams(parseQuery('big_tits blonde'))).toEqual({
      order: 'trending',
      type: 'g',
      tags: ['big tits', 'blonde'],
    });
  });

  it('maps keys through canonical spellings with fallback', () => {
    const canonical = new Map([['big tits', 'Big Tits']]);
    expect(serverParams(parseQuery('big_tits blonde'), canonical).tags).toEqual(['Big Tits', 'blonde']);
  });

  it('leaves tags undefined with no required tags', () => {
    const p = serverParams(parseQuery('~a ~b -c views:>1k'));
    expect(p.tags).toBeUndefined();
    expect(p).toEqual({ order: 'trending', type: 'g' });
  });

  it('passes order and type through', () => {
    expect(serverParams(parseQuery('a order:week type:image'))).toEqual({
      order: 'top7',
      type: 'i',
      tags: ['a'],
    });
    expect(serverParams(parseQuery('order:new')).order).toBe('latest');
  });

  it('ignores page sorts', () => {
    expect(serverParams(parseQuery('a order:views'))).toEqual({ order: 'trending', type: 'g', tags: ['a'] });
  });
});
