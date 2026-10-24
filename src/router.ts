// Client-side routing for /booru/... paths with history.pushState.
// Parsing and building URLs are pure functions; the store at the bottom wires
// them to the browser.

import { normalizeTag, toTagTerm } from './search/tags';

export const BASE = '/booru';

/** Where a post was opened from: '' = the global search, otherwise a creator or a pool (niche). */
export type PostSrc = '' | `user:${string}` | `niche:${string}`;

export function parsePostSrc(value: string | null): PostSrc {
  const text = (value ?? '').trim();
  return /^(user|niche):\S/.test(text) ? (text as PostSrc) : '';
}

export type PopularScale = 'day' | 'week' | 'month';
export const POPULAR_SCALES: readonly PopularScale[] = ['day', 'week', 'month'];

export type Route =
  | { name: 'posts'; tags: string; page: number }
  /**
   * `q` / `page`: the search and grid page the post was opened from (e621 style); '' / 1 when absent.
   * `src`: the stream the grid came from, '' (global search), 'user:<name>' or 'niche:<id>'.
   */
  | { name: 'post'; id: string; q: string; page: number; src: PostSrc }
  | { name: 'settings' }
  /** Tag wiki search page; `q` is an optional search text (shows matching tags). */
  | { name: 'wikiIndex'; q: string }
  /** `tag` is the normalized key ("big tits"); the URL carries the underscore term. */
  | { name: 'wiki'; tag: string }
  /** A creator's posts; `tags` is the search scoped to this creator. */
  | { name: 'user'; user: string; tags: string; page: number }
  | { name: 'pools'; page: number }
  /** A RedGifs niche shown as an e621 pool. */
  | { name: 'pool'; id: string; tags: string; page: number }
  | { name: 'popular'; scale: PopularScale }
  | { name: 'notFound'; path: string };

/** True for paths this script takes over; everything else stays RedGifs'. */
export function isBooruPath(pathname: string): boolean {
  return pathname === BASE || pathname.startsWith(`${BASE}/`);
}

function parsePage(value: string | null): number {
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 ? page : 1;
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parseScale(value: string | null): PopularScale {
  return (POPULAR_SCALES as readonly string[]).includes(value ?? '') ? (value as PopularScale) : 'day';
}

/** `?tags=&page=` for the scoped grids (creator, pool); empty when both are defaults. */
function gridQuery(tags: string, page: number): string {
  const params = new URLSearchParams();
  if (tags) params.set('tags', tags);
  if (page > 1) params.set('page', String(page));
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function parseRoute(pathname: string, search = ''): Route {
  const params = new URLSearchParams(search);
  const rest = pathname.slice(BASE.length).replace(/\/+$/, '');
  if (!isBooruPath(pathname)) return { name: 'notFound', path: pathname };
  if (rest === '' || rest === '/posts') {
    return { name: 'posts', tags: (params.get('tags') ?? '').trim(), page: parsePage(params.get('page')) };
  }
  const post = /^\/posts\/([A-Za-z0-9]+)$/.exec(rest);
  if (post) {
    return { name: 'post', id: post[1].toLowerCase(), q: (params.get('q') ?? '').trim(), page: parsePage(params.get('page')), src: parsePostSrc(params.get('src')) };
  }
  if (rest === '/settings') return { name: 'settings' };
  if (rest === '/wiki') return { name: 'wikiIndex', q: (params.get('q') ?? '').trim() };
  const wiki = /^\/wiki\/([^/]+)$/.exec(rest);
  if (wiki) {
    const tag = normalizeTag(decode(wiki[1]));
    return tag ? { name: 'wiki', tag } : { name: 'wikiIndex', q: '' };
  }
  const user = /^\/users\/([^/]+)$/.exec(rest);
  if (user) {
    const name = decode(user[1]).trim();
    if (name) return { name: 'user', user: name, tags: (params.get('tags') ?? '').trim(), page: parsePage(params.get('page')) };
  }
  if (rest === '/pools') return { name: 'pools', page: parsePage(params.get('page')) };
  const pool = /^\/pools\/([^/]+)$/.exec(rest);
  if (pool) {
    const id = decode(pool[1]).trim();
    if (id) return { name: 'pool', id, tags: (params.get('tags') ?? '').trim(), page: parsePage(params.get('page')) };
  }
  if (rest === '/popular') return { name: 'popular', scale: parseScale(params.get('scale')) };
  return { name: 'notFound', path: pathname };
}

export function hrefFor(route: Route): string {
  switch (route.name) {
    case 'posts': {
      const params = new URLSearchParams();
      if (route.tags) params.set('tags', route.tags);
      if (route.page > 1) params.set('page', String(route.page));
      const query = params.toString();
      return `${BASE}/posts${query ? `?${query}` : ''}`;
    }
    case 'post': {
      const params = new URLSearchParams();
      if (route.q) params.set('q', route.q);
      if (route.page > 1) params.set('page', String(route.page));
      if (route.src) params.set('src', route.src);
      const query = params.toString();
      return `${BASE}/posts/${encodeURIComponent(route.id)}${query ? `?${query}` : ''}`;
    }
    case 'settings':
      return `${BASE}/settings`;
    case 'wikiIndex':
      return `${BASE}/wiki${route.q ? `?q=${encodeURIComponent(route.q)}` : ''}`;
    case 'wiki':
      return `${BASE}/wiki/${encodeURIComponent(toTagTerm(route.tag))}`;
    case 'user':
      return `${BASE}/users/${encodeURIComponent(route.user)}${gridQuery(route.tags, route.page)}`;
    case 'pools':
      return `${BASE}/pools${route.page > 1 ? `?page=${route.page}` : ''}`;
    case 'pool':
      return `${BASE}/pools/${encodeURIComponent(route.id)}${gridQuery(route.tags, route.page)}`;
    case 'popular':
      return `${BASE}/popular${route.scale !== 'day' ? `?scale=${route.scale}` : ''}`;
    case 'notFound':
      return route.path;
  }
}

/** The matching page in RedGifs' own interface, for the "Use RedGifs' interface" link. */
export function redgifsUrlFor(route: Route): string {
  switch (route.name) {
    case 'post': return `/watch/${encodeURIComponent(route.id)}`;
    case 'user': return `/users/${encodeURIComponent(route.user)}`;
    case 'pool': return `/niches/${encodeURIComponent(route.id)}`;
    case 'pools': return '/niches';
    default: return '/';
  }
}

/**
 * Whether a click on a link should be handled by the router instead of a full
 * page load: same origin, a /booru path, a plain left click, no target.
 */
export function shouldIntercept(
  event: Pick<MouseEvent, 'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'defaultPrevented'>,
  anchor: { href: string; target: string; hasAttribute(name: string): boolean },
  origin: string,
): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  if (anchor.target && anchor.target !== '_self') return false;
  if (anchor.hasAttribute('download')) return false;
  let url: URL;
  try {
    url = new URL(anchor.href);
  } catch {
    return false;
  }
  return url.origin === origin && isBooruPath(url.pathname);
}

type Listener = (route: Route) => void;

export class Router {
  private listeners = new Set<Listener>();
  route: Route;

  constructor(private readonly win: Window = window) {
    this.route = this.read();
    win.addEventListener('popstate', () => this.update());
  }

  private read(): Route {
    return parseRoute(this.win.location.pathname, this.win.location.search);
  }

  private update(): void {
    this.route = this.read();
    for (const listener of this.listeners) listener(this.route);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  navigate(href: string, { replace = false } = {}): void {
    const method = replace ? 'replaceState' : 'pushState';
    this.win.history[method](null, '', href);
    this.update();
    if (!replace) this.win.scrollTo(0, 0);
  }

  /** Catches clicks on /booru links anywhere in the page. */
  interceptLinks(root: Document | HTMLElement = this.win.document): () => void {
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.('a');
      if (!anchor || !shouldIntercept(event, anchor, this.win.location.origin)) return;
      event.preventDefault();
      const url = new URL(anchor.href);
      this.navigate(url.pathname + url.search + url.hash);
    };
    root.addEventListener('click', onClick as EventListener);
    return () => root.removeEventListener('click', onClick as EventListener);
  }
}
