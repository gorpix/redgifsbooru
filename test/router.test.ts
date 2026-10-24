import { describe, expect, it, vi } from 'vitest';
import { Router, hrefFor, isBooruPath, parseRoute, redgifsUrlFor, shouldIntercept, type Route } from '../src/router';

describe('parseRoute', () => {
  it('maps /booru, /booru/ and /booru/posts to posts', () => {
    for (const p of ['/booru', '/booru/', '/booru/posts', '/booru/posts/']) {
      expect(parseRoute(p)).toEqual({ name: 'posts', tags: '', page: 1 });
    }
  });

  it('parses tags and page', () => {
    expect(parseRoute('/booru/posts', '?tags=a%2Cb&page=3')).toEqual({ name: 'posts', tags: 'a,b', page: 3 });
    expect(parseRoute('/booru/posts', '?tags=%20x%20')).toMatchObject({ tags: 'x' });
  });

  it('falls back to page 1 for invalid pages', () => {
    for (const q of ['?page=0', '?page=-2', '?page=abc', '?page=1.5', '?page=']) {
      expect(parseRoute('/booru/posts', q)).toMatchObject({ page: 1 });
    }
  });

  it('parses a post id and lowercases it', () => {
    expect(parseRoute('/booru/posts/AbC')).toEqual({ name: 'post', id: 'abc', q: '', page: 1, src: '' });
    expect(parseRoute('/booru/posts/AbC/')).toEqual({ name: 'post', id: 'abc', q: '', page: 1, src: '' });
  });

  it('parses and builds the post src, dropping bad values', () => {
    expect(parseRoute('/booru/posts/abc', '?src=user%3AFoo+Bar&page=2')).toEqual({ name: 'post', id: 'abc', q: '', page: 2, src: 'user:Foo Bar' });
    expect(parseRoute('/booru/posts/abc', '?src=niche%3Apale-girls')).toMatchObject({ src: 'niche:pale-girls' });
    for (const bad of ['?src=', '?src=user%3A', '?src=other%3Ax', '?src=search']) {
      expect(parseRoute('/booru/posts/abc', bad)).toMatchObject({ src: '' });
    }
    expect(hrefFor({ name: 'post', id: 'abc', q: '', page: 1, src: 'user:Foo Bar' })).toBe('/booru/posts/abc?src=user%3AFoo+Bar');
    expect(hrefFor({ name: 'post', id: 'abc', q: 'x', page: 2, src: 'niche:pale-girls' })).toBe('/booru/posts/abc?q=x&page=2&src=niche%3Apale-girls');
  });

  it('parses q and page on a post, with defaults for bad values', () => {
    expect(parseRoute('/booru/posts/abc', '?q=%20red%20hair%2Cblue&page=4')).toEqual({ name: 'post', id: 'abc', q: 'red hair,blue', page: 4, src: '' });
    expect(parseRoute('/booru/posts/abc', '?page=0')).toMatchObject({ q: '', page: 1 });
    expect(parseRoute('/booru/posts/abc', '?page=x')).toMatchObject({ page: 1 });
  });

  it('parses settings', () => {
    expect(parseRoute('/booru/settings')).toEqual({ name: 'settings' });
  });

  it('returns notFound for unknown and non-booru paths', () => {
    expect(parseRoute('/booru/x')).toEqual({ name: 'notFound', path: '/booru/x' });
    expect(parseRoute('/booru/posts/a/b')).toMatchObject({ name: 'notFound' });
    expect(parseRoute('/watch/abc')).toEqual({ name: 'notFound', path: '/watch/abc' });
    expect(parseRoute('/booruish')).toMatchObject({ name: 'notFound' });
  });
});

describe('isBooruPath', () => {
  it('matches only /booru and its subpaths', () => {
    expect(isBooruPath('/booru')).toBe(true);
    expect(isBooruPath('/booru/posts')).toBe(true);
    expect(isBooruPath('/booruish')).toBe(false);
    expect(isBooruPath('/')).toBe(false);
  });
});

describe('hrefFor', () => {
  it('builds expected hrefs', () => {
    expect(hrefFor({ name: 'posts', tags: '', page: 1 })).toBe('/booru/posts');
    expect(hrefFor({ name: 'posts', tags: 'a,b', page: 2 })).toBe('/booru/posts?tags=a%2Cb&page=2');
    expect(hrefFor({ name: 'post', id: 'abc', q: '', page: 1, src: '' })).toBe('/booru/posts/abc');
    expect(hrefFor({ name: 'post', id: 'abc', q: 'a,b', page: 1, src: '' })).toBe('/booru/posts/abc?q=a%2Cb');
    expect(hrefFor({ name: 'post', id: 'abc', q: '', page: 2, src: '' })).toBe('/booru/posts/abc?page=2');
    expect(hrefFor({ name: 'post', id: 'abc', q: 'x', page: 3, src: '' })).toBe('/booru/posts/abc?q=x&page=3');
    expect(hrefFor({ name: 'settings' })).toBe('/booru/settings');
    expect(hrefFor({ name: 'notFound', path: '/booru/x' })).toBe('/booru/x');
  });

  it('round-trips through parseRoute', () => {
    const routes: Route[] = [
      { name: 'posts', tags: '', page: 1 },
      { name: 'posts', tags: 'red hair,blue', page: 4 },
      { name: 'post', id: 'abcdef', q: 'red hair,blue', page: 3, src: '' },
      { name: 'post', id: 'abcdef', q: '', page: 2, src: 'user:Some Name' },
      { name: 'post', id: 'abcdef', q: 'a,b', page: 1, src: 'niche:pale-girls' },
      { name: 'settings' },
      { name: 'notFound', path: '/booru/nope' },
    ];
    for (const route of routes) {
      const url = new URL(hrefFor(route), 'https://www.redgifs.com');
      expect(parseRoute(url.pathname, url.search)).toEqual(route);
    }
  });
});

describe('redgifsUrlFor', () => {
  it('links posts to /watch and everything else to /', () => {
    expect(redgifsUrlFor({ name: 'post', id: 'abc', q: '', page: 1, src: '' })).toBe('/watch/abc');
    expect(redgifsUrlFor({ name: 'posts', tags: 'x', page: 2 })).toBe('/');
    expect(redgifsUrlFor({ name: 'settings' })).toBe('/');
  });
});

describe('shouldIntercept', () => {
  const origin = 'https://www.redgifs.com';
  const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
  const link = (href: string, target = '', attrs: string[] = []) => ({
    href,
    target,
    hasAttribute: (name: string) => attrs.includes(name),
  });
  const good = link(`${origin}/booru/posts?tags=a`);

  it('is true for a plain same-origin booru link', () => {
    expect(shouldIntercept(click, good, origin)).toBe(true);
    expect(shouldIntercept(click, link(`${origin}/booru`, '_self'), origin)).toBe(true);
  });

  it('is false for modifier keys, other buttons and prevented clicks', () => {
    for (const key of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey', 'defaultPrevented'] as const) {
      expect(shouldIntercept({ ...click, [key]: true }, good, origin)).toBe(false);
    }
    expect(shouldIntercept({ ...click, button: 1 }, good, origin)).toBe(false);
    expect(shouldIntercept({ ...click, button: 2 }, good, origin)).toBe(false);
  });

  it('is false for target=_blank, download, other origin, non-booru path, bad href', () => {
    expect(shouldIntercept(click, link(good.href, '_blank'), origin)).toBe(false);
    expect(shouldIntercept(click, link(good.href, '', ['download']), origin)).toBe(false);
    expect(shouldIntercept(click, link('https://evil.example/booru/posts'), origin)).toBe(false);
    expect(shouldIntercept(click, link(`${origin}/watch/abc`), origin)).toBe(false);
    expect(shouldIntercept(click, link('not a url'), origin)).toBe(false);
  });
});

function fakeWindow(initial = '/booru/posts') {
  const origin = 'https://www.redgifs.com';
  const location = { pathname: '', search: '', origin };
  const set = (href: string) => {
    const url = new URL(href, origin);
    location.pathname = url.pathname;
    location.search = url.search;
  };
  set(initial);
  const listeners: Record<string, Array<() => void>> = {};
  const history = {
    pushState: vi.fn((_s: unknown, _t: string, href: string) => set(href)),
    replaceState: vi.fn((_s: unknown, _t: string, href: string) => set(href)),
  };
  const win = {
    location,
    history,
    scrollTo: vi.fn(),
    addEventListener: vi.fn((type: string, fn: () => void) => { (listeners[type] ??= []).push(fn); }),
  };
  return {
    win: win as unknown as Window,
    raw: win,
    history,
    popstate: (href: string) => { set(href); listeners.popstate?.forEach((fn) => fn()); },
  };
}

describe('Router', () => {
  it('reads the initial route', () => {
    const { win } = fakeWindow('/booru/posts/XyZ');
    expect(new Router(win).route).toEqual({ name: 'post', id: 'xyz', q: '', page: 1, src: '' });
  });

  it('navigate pushes state, notifies subscribers and scrolls to top', () => {
    const f = fakeWindow();
    const router = new Router(f.win);
    const listener = vi.fn();
    router.subscribe(listener);
    router.navigate('/booru/posts?tags=cat&page=2');
    expect(f.history.pushState).toHaveBeenCalledWith(null, '', '/booru/posts?tags=cat&page=2');
    expect(router.route).toEqual({ name: 'posts', tags: 'cat', page: 2 });
    expect(listener).toHaveBeenCalledWith({ name: 'posts', tags: 'cat', page: 2 });
    expect(f.raw.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('replace uses replaceState and does not scroll', () => {
    const f = fakeWindow();
    const router = new Router(f.win);
    const listener = vi.fn();
    router.subscribe(listener);
    router.navigate('/booru/settings', { replace: true });
    expect(f.history.replaceState).toHaveBeenCalled();
    expect(f.history.pushState).not.toHaveBeenCalled();
    expect(f.raw.scrollTo).not.toHaveBeenCalled();
    expect(router.route).toEqual({ name: 'settings' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('popstate updates the route and notifies', () => {
    const f = fakeWindow();
    const router = new Router(f.win);
    const listener = vi.fn();
    router.subscribe(listener);
    f.popstate('/booru/posts/Q1');
    expect(router.route).toEqual({ name: 'post', id: 'q1', q: '', page: 1, src: '' });
    expect(listener).toHaveBeenCalledWith({ name: 'post', id: 'q1', q: '', page: 1, src: '' });
  });

  it('unsubscribe stops notifications', () => {
    const f = fakeWindow();
    const router = new Router(f.win);
    const listener = vi.fn();
    const off = router.subscribe(listener);
    off();
    router.navigate('/booru/settings');
    expect(listener).not.toHaveBeenCalled();
  });
});
