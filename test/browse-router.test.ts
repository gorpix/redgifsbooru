import { describe, expect, it } from 'vitest';
import { hrefFor, parseRoute, redgifsUrlFor, type Route } from '../src/router';

describe('phase 4 routes: parse', () => {
  it('wiki index with and without q', () => {
    expect(parseRoute('/booru/wiki')).toEqual({ name: 'wikiIndex', q: '' });
    expect(parseRoute('/booru/wiki/')).toEqual({ name: 'wikiIndex', q: '' });
    expect(parseRoute('/booru/wiki', '?q=%20big%20')).toEqual({ name: 'wikiIndex', q: 'big' });
  });

  it('wiki page uses the normalized key', () => {
    expect(parseRoute('/booru/wiki/big_tits')).toEqual({ name: 'wiki', tag: 'big tits' });
    expect(parseRoute('/booru/wiki/Big%20Tits')).toEqual({ name: 'wiki', tag: 'big tits' });
    expect(parseRoute('/booru/wiki/red-hair')).toEqual({ name: 'wiki', tag: 'red hair' });
    expect(parseRoute('/booru/wiki/___')).toEqual({ name: 'wikiIndex', q: '' });
    expect(parseRoute('/booru/wiki/a/b')).toMatchObject({ name: 'notFound' });
  });

  it('creator page with tags and page', () => {
    expect(parseRoute('/booru/users/SomeUser')).toEqual({ name: 'user', user: 'SomeUser', tags: '', page: 1 });
    expect(parseRoute('/booru/users/some%20user', '?tags=red_hair&page=3')).toEqual({ name: 'user', user: 'some user', tags: 'red_hair', page: 3 });
    expect(parseRoute('/booru/users/x', '?page=0')).toMatchObject({ page: 1 });
    expect(parseRoute('/booru/users')).toMatchObject({ name: 'notFound' });
  });

  it('pools index and pool', () => {
    expect(parseRoute('/booru/pools')).toEqual({ name: 'pools', page: 1 });
    expect(parseRoute('/booru/pools', '?page=4')).toEqual({ name: 'pools', page: 4 });
    expect(parseRoute('/booru/pools/pale-girls')).toEqual({ name: 'pool', id: 'pale-girls', tags: '', page: 1 });
    expect(parseRoute('/booru/pools/pale-girls/', '?tags=a%2Cb&page=2')).toEqual({ name: 'pool', id: 'pale-girls', tags: 'a,b', page: 2 });
    expect(parseRoute('/booru/pools/a/b')).toMatchObject({ name: 'notFound' });
  });

  it('popular with scale, defaulting to day', () => {
    expect(parseRoute('/booru/popular')).toEqual({ name: 'popular', scale: 'day' });
    expect(parseRoute('/booru/popular', '?scale=week')).toEqual({ name: 'popular', scale: 'week' });
    expect(parseRoute('/booru/popular', '?scale=month')).toEqual({ name: 'popular', scale: 'month' });
    expect(parseRoute('/booru/popular', '?scale=year')).toEqual({ name: 'popular', scale: 'day' });
  });

  it('survives a malformed percent escape', () => {
    expect(parseRoute('/booru/users/%E0%A4%A')).toMatchObject({ name: 'user', user: '%E0%A4%A' });
  });
});

describe('phase 4 routes: hrefFor', () => {
  it('builds the documented URLs', () => {
    expect(hrefFor({ name: 'wikiIndex', q: '' })).toBe('/booru/wiki');
    expect(hrefFor({ name: 'wikiIndex', q: 'big t' })).toBe('/booru/wiki?q=big%20t');
    expect(hrefFor({ name: 'wiki', tag: 'big tits' })).toBe('/booru/wiki/big_tits');
    expect(hrefFor({ name: 'user', user: 'Some User', tags: '', page: 1 })).toBe('/booru/users/Some%20User');
    expect(hrefFor({ name: 'user', user: 'bob', tags: 'a,b', page: 2 })).toBe('/booru/users/bob?tags=a%2Cb&page=2');
    expect(hrefFor({ name: 'pools', page: 1 })).toBe('/booru/pools');
    expect(hrefFor({ name: 'pools', page: 3 })).toBe('/booru/pools?page=3');
    expect(hrefFor({ name: 'pool', id: 'pale-girls', tags: '', page: 1 })).toBe('/booru/pools/pale-girls');
    expect(hrefFor({ name: 'pool', id: 'pale-girls', tags: 'x', page: 2 })).toBe('/booru/pools/pale-girls?tags=x&page=2');
    expect(hrefFor({ name: 'popular', scale: 'day' })).toBe('/booru/popular');
    expect(hrefFor({ name: 'popular', scale: 'week' })).toBe('/booru/popular?scale=week');
  });

  it('round-trips through parseRoute', () => {
    const routes: Route[] = [
      { name: 'wikiIndex', q: '' },
      { name: 'wikiIndex', q: 'big t' },
      { name: 'wiki', tag: 'big tits' },
      { name: 'wiki', tag: 'café noir' },
      { name: 'user', user: 'Some User', tags: 'red_hair,-x', page: 3 },
      { name: 'user', user: 'bob', tags: '', page: 1 },
      { name: 'pools', page: 1 },
      { name: 'pools', page: 7 },
      { name: 'pool', id: 'pale-girls', tags: 'a b', page: 2 },
      { name: 'popular', scale: 'day' },
      { name: 'popular', scale: 'month' },
    ];
    for (const route of routes) {
      const url = new URL(hrefFor(route), 'https://www.redgifs.com');
      expect(parseRoute(url.pathname, url.search)).toEqual(route);
    }
  });
});

describe('phase 4 redgifsUrlFor', () => {
  it('points at the matching RedGifs pages', () => {
    expect(redgifsUrlFor({ name: 'user', user: 'Some User', tags: '', page: 1 })).toBe('/users/Some%20User');
    expect(redgifsUrlFor({ name: 'pool', id: 'pale-girls', tags: '', page: 1 })).toBe('/niches/pale-girls');
    expect(redgifsUrlFor({ name: 'pools', page: 1 })).toBe('/niches');
    expect(redgifsUrlFor({ name: 'popular', scale: 'week' })).toBe('/');
    expect(redgifsUrlFor({ name: 'wiki', tag: 'x' })).toBe('/');
    expect(redgifsUrlFor({ name: 'wikiIndex', q: '' })).toBe('/');
  });
});
