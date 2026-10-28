// Every RedGifs API call goes through here: guard, cache, queue, token,
// retries and rate-limit backoff. When RedGifs changes, this is where to fix.
import { AccountApi } from './account';
import type { AuthManager } from './auth';
import type { ResponseCache } from './cache';
import { API_ROOT, isForbiddenUrl } from './guard';
import { ForbiddenEndpointError, HttpError, RateLimitedError, type HttpMethod, type Transport } from './http';
import { readNiche, readNichesPage, readTagWiki, readUserProfile } from './normalize';
import { LOW_PAUSED_KEY, RATE_LIMIT_KEY, writeStoredMax } from './budget';
import { RequestQueue, realClock, type Clock } from './queue';
import { normalizeTag } from '../search/tags';
import { TokenManager } from './token';
import type { Gif, Niche, NichesPage, SearchPage, SearchParams, TagWiki, User, UserProfile } from './types';

const MAX_AUTH_ATTEMPTS = 3;
const MAX_TRANSIENT_RETRIES = 1;
const TRANSIENT_RETRY_MS = 2_000;
/** Pauses after successive 429s; one more 429 after the last gives up. */
const DEFAULT_BACKOFF_MS = [60_000, 180_000];
/** How long the queue stays paused after giving up on a 429. */
const GIVE_UP_PAUSE_MS = 10 * 60_000;
/** After any 429, low-priority requests (tag counts) stay away this long. */
const LOW_PAUSE_MS = 15 * 60_000;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Personalized responses are kept in memory at most this long, never in IndexedDB. */
const PERSONAL_TTL_MS = 60_000;

/** Responses that depend on who is logged in: never written to the persistent cache. */
const PERSONAL_PATHS = [/^\/v1\/me(\/|$)/, /^\/v2\/me(\/|$)/, /^\/v2\/likes(\/|$)/, /^\/v2\/feeds\/liked(\/|$)/];
export const isPersonalPath = (pathname: string): boolean => PERSONAL_PATHS.some((p) => p.test(pathname));

/** The only paths the booru writes to: likes, follows and my collections. */
const WRITABLE_PATHS = [/^\/v2\/gifs\/[^/]+\/like$/, /^\/v1\/me\/follows\/[^/]+$/, /^\/v2\/me\/collections(\/|$)/];
export const isWritablePath = (pathname: string): boolean => WRITABLE_PATHS.some((p) => p.test(pathname));

/** Memoized personal reads that a write to `pathname` makes stale (path prefixes). */
function staleAfterWrite(pathname: string): string[] {
  if (/^\/v2\/gifs\/[^/]+\/like$/.test(pathname)) return ['/v2/likes', '/v2/feeds/liked'];
  if (pathname.startsWith('/v1/me/follows')) return ['/v1/me/follows', '/v2/me/following'];
  if (pathname.startsWith('/v2/me/collections')) return ['/v2/me/collections'];
  return ['/v1/me', '/v2/me', '/v2/likes', '/v2/feeds/liked'];
}

const abortError = () => new DOMException('Aborted', 'AbortError');

export interface ApiStatus {
  /** Unix ms until which requests are held back; 0 when not rate-limited. */
  rateLimitedUntil: number;
  /** True once retrying stopped and the user should open RedGifs. */
  gaveUp: boolean;
}

/** One network request that went through the queue (cache hits emit nothing). Used for debugging. */
export interface RequestEvent {
  path: string;          // URL pathname + search, without the origin
  priority: 'high' | 'low';
  waitMs: number;        // from creating the shared request (startRequest) until the queue started it
  durationMs: number;    // from queue start until it settled
  outcome: 'ok' | 'error' | 'aborted';
  error?: string;        // error name/message when not ok
  rateLimited: boolean;  // true if any HTTP 429 was seen during this request
}

export interface ApiOptions {
  transport: Transport;
  cache?: ResponseCache | null;
  /** Guest token source (used when nobody is logged in). */
  tokens?: TokenManager;
  /** Login: its id_token is used when logged in. */
  auth?: AuthManager | null;
  queue?: RequestQueue;
  /** Where 429 pauses are shared with other tabs (localStorage); none by default. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  clock?: Clock;
  backoffMs?: number[];
  timeoutMs?: number;
  /** Called once per queued request when it settles. Errors thrown by it are ignored. */
  onRequest?: (event: RequestEvent) => void;
}

/** Per-request facts collected while `request()` runs. */
interface RequestContext {
  rateLimited: boolean;
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export interface GetOptions {
  /** Max age of a cached response to reuse; 0 skips the cache. */
  ttlMs?: number;
  priority?: 'high' | 'low';
  signal?: AbortSignal;
}

interface InFlight<T> {
  promise: Promise<T>;
  controller: AbortController;
  /** Callers sharing this request that have not aborted. */
  callers: number;
  /** True once the queue has started the request (it is then never aborted). */
  started: boolean;
}

export interface TagSuggestion {
  text: string;
  count: number;
}

type Params = Record<string, string | number | undefined>;

export function buildUrl(path: string, params: Params = {}): string {
  const url = new URL(path, API_ROOT);
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export class RedgifsApi {
  private readonly transport: Transport;
  private readonly cache: ResponseCache | null;
  private readonly tokens: TokenManager;
  private readonly auth: AuthManager | null;
  /** Personal reads, in memory only: key -> data, pathname (for invalidation) and time. */
  private readonly memo = new Map<string, { data: unknown; path: string; at: number }>();
  /** Bumped when personal data goes stale, so a read that started before is not memoized. */
  private epoch = 0;
  /** My likes, follows and collections. */
  readonly account: AccountApi;
  private readonly queue: RequestQueue;
  private readonly clock: Clock;
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  private readonly backoffMs: number[];
  private readonly timeoutMs: number;
  private readonly onRequest?: (event: RequestEvent) => void;
  private readonly inFlight = new Map<string, InFlight<any>>();
  private readonly listeners = new Set<(status: ApiStatus) => void>();
  status: ApiStatus = { rateLimitedUntil: 0, gaveUp: false };

  constructor(options: ApiOptions) {
    this.transport = options.transport;
    this.cache = options.cache ?? null;
    this.clock = options.clock ?? realClock;
    this.storage = options.storage ?? null;
    this.tokens = options.tokens ?? new TokenManager(this.transport, null, () => this.clock.now());
    this.auth = options.auth ?? null;
    this.account = new AccountApi(this);
    if (this.auth) {
      this.auth.setUsernameLoader(async () => (await this.account.me()).username);
      // A login, logout or account switch makes every personal response stale.
      this.auth.subscribe(() => this.invalidatePersonal(null));
    }
    this.queue = options.queue ?? new RequestQueue({ clock: this.clock });
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.onRequest = options.onRequest;
  }

  onStatus(listener: (status: ApiStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(status: ApiStatus): void {
    if (status.rateLimitedUntil === this.status.rateLimitedUntil && status.gaveUp === this.status.gaveUp) return;
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }

  /**
   * GET a JSON endpoint, from the cache when fresh enough.
   *
   * De-duplication: identical concurrent calls share one request. The shared request is
   * aborted only when EVERY caller has aborted and it has not started yet (a caller without
   * a signal never aborts). A request that has started is never cancelled: it completes and
   * is cached, while an aborting caller's own promise rejects at once. The request runs at
   * the priority of the caller that created it.
   */
  async getJson<T>(path: string, params: Params = {}, { ttlMs = DEFAULT_TTL_MS, priority, signal }: GetOptions = {}): Promise<T> {
    const url = buildUrl(path, params);
    if (isForbiddenUrl(url)) throw new ForbiddenEndpointError(url);
    if (signal?.aborted) throw abortError();

    if (isPersonalPath(new URL(url).pathname)) {
      const hit = ttlMs > 0 ? this.memo.get(url) : undefined;
      if (hit && this.clock.now() - hit.at <= Math.min(ttlMs, PERSONAL_TTL_MS)) return hit.data as T;
    } else if (ttlMs > 0 && this.cache) {
      const cached = await this.cache.get<T>(url, ttlMs).catch(() => undefined);
      if (cached !== undefined) return cached;
      if (signal?.aborted) throw abortError();
    }

    let entry = this.inFlight.get(url) as InFlight<T> | undefined;
    if (!entry) entry = this.startRequest<T>(url, priority);
    entry.callers += 1;
    const shared = entry;
    if (!signal) return shared.promise;

    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        shared.callers -= 1;
        if (shared.callers === 0 && !shared.started) {
          if (this.inFlight.get(url) === shared) this.inFlight.delete(url);
          shared.controller.abort();
        }
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      shared.promise.then(
        (data) => { signal.removeEventListener('abort', onAbort); resolve(data); },
        (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
      );
    });
  }

  private startRequest<T>(url: string, priority: GetOptions['priority']): InFlight<T> {
    const controller = new AbortController();
    const entry: InFlight<T> = { promise: undefined as unknown as Promise<T>, controller, callers: 0, started: false };

    const { pathname } = new URL(url);
    const personal = isPersonalPath(pathname);
    const epoch = this.epoch;
    const { context, markStarted, wasStarted, report } = this.reporter(url, priority);

    entry.promise = this.queue.run(() => {
      entry.started = true;
      markStarted();
      return this.request<T>(url, context, { personal });
    }, { priority, signal: controller.signal }).then(
      async (data) => {
        report('ok');
        if (personal) {
          // Memory only, and only if nothing made it stale meanwhile.
          if (epoch === this.epoch) this.memo.set(url, { data, path: pathname, at: this.clock.now() });
        } else if (this.cache) {
          await this.cache.set(url, data).catch(() => undefined);
        }
        return data;
      },
      (error: unknown) => {
        report(wasStarted() ? 'error' : 'aborted', error);
        throw error;
      },
    ).finally(() => {
      if (this.inFlight.get(url) === entry) this.inFlight.delete(url);
    });
    this.inFlight.set(url, entry);
    return entry;
  }

  /** Timing and outcome for the debug hook (onRequest). Uses the injected clock. */
  private reporter(url: string, priority: GetOptions['priority']) {
    const { pathname, search } = new URL(url);
    const createdAt = this.clock.now();
    const context: RequestContext = { rateLimited: false };
    let startedAt: number | undefined;
    const report = (outcome: RequestEvent['outcome'], error?: unknown) => {
      if (!this.onRequest) return;
      const settledAt = this.clock.now();
      const event: RequestEvent = {
        path: pathname + search,
        priority: priority ?? 'high',
        // An aborted request never started: its wait runs until it was dropped.
        waitMs: (startedAt ?? settledAt) - createdAt,
        durationMs: startedAt === undefined ? 0 : settledAt - startedAt,
        outcome,
        rateLimited: context.rateLimited,
      };
      if (outcome !== 'ok') event.error = describeError(error);
      try {
        this.onRequest(event);
      } catch {
        // A debug hook must never break a request.
      }
    };
    return {
      context,
      report,
      markStarted: () => { startedAt = this.clock.now(); },
      wasStarted: () => startedAt !== undefined,
    };
  }

  /** Drops memoized personal reads (all, or those under the given path prefixes) and in-flight ones. */
  private invalidatePersonal(prefixes: string[] | null): void {
    this.epoch += 1;
    const stale = (path: string) => prefixes === null || prefixes.some((p) => path.startsWith(p));
    for (const [key, entry] of [...this.memo]) if (stale(entry.path)) this.memo.delete(key);
    for (const url of [...this.inFlight.keys()]) {
      const { pathname } = new URL(url);
      if (isPersonalPath(pathname) && stale(pathname)) this.inFlight.delete(url);
    }
  }

  /**
   * Write to my account (likes, follows, collections): PUT/POST/PATCH/DELETE with an optional
   * JSON body. High priority, through the queue and budget, never cached or de-duplicated, and
   * NEVER retried automatically, except once after a 401 when the login token is refreshed.
   * Needs a logged-in user (else HttpError 401). Related memoized reads are dropped afterwards.
   * Resolves with the parsed JSON reply, or null when it has none.
   */
  async send<T = unknown>(method: Exclude<HttpMethod, 'GET'>, path: string, body?: unknown, { signal }: { signal?: AbortSignal } = {}): Promise<T | null> {
    const url = buildUrl(path);
    const { pathname } = new URL(url);
    if (isForbiddenUrl(url) || !isWritablePath(pathname)) throw new ForbiddenEndpointError(url);
    if (signal?.aborted) throw abortError();
    const { context, markStarted, wasStarted, report } = this.reporter(url, 'high');
    try {
      const data = await this.queue.run(() => {
        markStarted();
        return this.request<T | null>(url, context, { method, body, write: true });
      }, { priority: 'high', signal });
      report('ok');
      return data;
    } catch (error) {
      report(wasStarted() ? 'error' : 'aborted', error);
      throw error;
    } finally {
      // Even a failed write may have gone through, so reads are refetched either way.
      this.invalidatePersonal(staleAfterWrite(pathname));
    }
  }

  private async request<T>(
    url: string,
    context: RequestContext,
    { method = 'GET', body, personal = false, write = false }: { method?: HttpMethod; body?: unknown; personal?: boolean; write?: boolean } = {},
  ): Promise<T> {
    let authFailures = 0;
    let rateLimitHits = 0;
    let transientFailures = 0;
    let refresh = false;
    let userRetried = false;

    for (;;) {
      // The login token when logged in (always for personal reads and writes), else the guest token.
      let token: string | null = null;
      if (this.auth && (write || personal || this.auth.state === 'loggedIn')) token = await this.auth.getToken();
      const isUser = token !== null;
      if (token === null) {
        if (write || personal) throw new HttpError(401, url);
        token = await this.tokens.get(refresh);
      }
      refresh = false;
      let status: number;
      let text = '';
      try {
        ({ status, text } = await this.transport({
          ...(write ? { method, ...(body === undefined ? {} : { body }) } : {}),
          url,
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
          timeoutMs: this.timeoutMs,
        }));
      } catch (error) {
        if (write || transientFailures++ >= MAX_TRANSIENT_RETRIES) throw error;
        await this.clock.sleep(TRANSIENT_RETRY_MS);
        continue;
      }

      if (status >= 200 && status < 300) {
        if (this.status.rateLimitedUntil) this.setStatus({ rateLimitedUntil: 0, gaveUp: false });
        if (write) {
          try { return (text.trim() ? JSON.parse(text) : null) as T; } catch { return null as T; }
        }
        return JSON.parse(text) as T;
      }
      if (isUser && status === 401) {
        if (userRetried) {
          // A fresh token was refused too: report it, but never log out.
          this.auth!.markError();
          if (write || personal) throw new HttpError(401, url);
          continue; // public reads carry on as a guest
        }
        userRetried = true;
        await this.auth!.refresh(true);
        continue;
      }
      if (write || (isUser && status === 403)) {
        if (status === 429) {
          const retryAt = this.clock.now() + this.backoffMs[0];
          this.queue.pauseUntil(retryAt);
          writeStoredMax(this.storage, RATE_LIMIT_KEY, retryAt);
          this.setStatus({ rateLimitedUntil: retryAt, gaveUp: false });
          context.rateLimited = true;
          throw new RateLimitedError(url, retryAt);
        }
        throw new HttpError(status, url);
      }
      if (status === 401 || status === 403) {
        if (++authFailures >= MAX_AUTH_ATTEMPTS) throw new HttpError(status, url);
        refresh = true;
        continue;
      }
      if (status === 429) {
        context.rateLimited = true;
        const now = this.clock.now();
        writeStoredMax(this.storage, LOW_PAUSED_KEY, now + LOW_PAUSE_MS);
        if (rateLimitHits >= this.backoffMs.length) {
          const retryAt = now + GIVE_UP_PAUSE_MS;
          this.queue.pauseUntil(retryAt);
          writeStoredMax(this.storage, RATE_LIMIT_KEY, retryAt);
          this.setStatus({ rateLimitedUntil: retryAt, gaveUp: true });
          throw new RateLimitedError(url, retryAt);
        }
        const retryAt = now + this.backoffMs[rateLimitHits++];
        this.queue.pauseUntil(retryAt);
        writeStoredMax(this.storage, RATE_LIMIT_KEY, retryAt);
        this.setStatus({ rateLimitedUntil: retryAt, gaveUp: false });
        await this.queue.waitForTurn();
        continue;
      }
      if (status >= 500 && transientFailures++ < MAX_TRANSIENT_RETRIES) {
        await this.clock.sleep(TRANSIENT_RETRY_MS);
        continue;
      }
      throw new HttpError(status, url);
    }
  }

  /** One server page of search results. Ads (boosted/promoted) are dropped. */
  async searchGifs(
    { order = 'trending', type = 'g', count = 100, page = 1, tags }: SearchParams = {},
    { signal, priority }: Pick<GetOptions, 'signal' | 'priority'> = {},
  ): Promise<SearchPage> {
    const data = await this.getJson<Record<string, unknown>>('/v2/gifs/search', {
      order,
      type,
      count,
      page,
      tags: tags?.length ? tags.join(',') : undefined,
    }, { signal, priority });
    return {
      gifs: (data.gifs as Gif[] | undefined) ?? [],
      page: Number(data.page) || page,
      pages: Number(data.pages) || 0,
      total: Number(data.total) || 0,
      users: (data.users as User[] | undefined) ?? [],
    };
  }

  /**
   * One page of a creator's posts (`/v2/users/:name/search`), same shape as searchGifs; ads dropped.
   * `type` g = videos/gifs (default), i = images. Defaults: order latest, 100 per page (like
   * searchGifs); pass `count` explicitly (the post page uses 12).
   */
  async userGifs(
    name: string,
    { order = 'latest', type = 'g', count = 100, page = 1, tags }: Pick<SearchParams, 'order' | 'type' | 'count' | 'page' | 'tags'> = {},
    { signal, priority }: Pick<GetOptions, 'signal' | 'priority'> = {},
  ): Promise<SearchPage> {
    const data = await this.getJson<Record<string, unknown>>(`/v2/users/${encodeURIComponent(name)}/search`, {
      order,
      type,
      count,
      page,
      tags: tags?.length ? tags.join(',') : undefined,
    }, { signal, priority });
    return {
      gifs: (data.gifs as Gif[] | undefined) ?? [],
      page: Number(data.page) || page,
      pages: Number(data.pages) || 0,
      total: Number(data.total) || 0,
      users: (data.users as User[] | undefined) ?? [],
    };
  }

  /** GET that turns a 404 into null (unknown tag, creator or niche). Other errors are thrown. */
  private async getJsonOrNull(path: string, params: Params, options: GetOptions): Promise<unknown> {
    try {
      return await this.getJson<unknown>(path, params, options);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
  }

  /** RedGifs' wiki entry for a tag (`name` in RedGifs' spelling, see matchTag); null when it has none. Cached a day. */
  async tagWiki(name: string, { priority, signal }: Pick<GetOptions, 'priority' | 'signal'> = {}): Promise<TagWiki | null> {
    const data = await this.getJsonOrNull(`/v2/tags/${encodeURIComponent(name)}`, {}, { ttlMs: DAY_MS, priority, signal });
    return data === null ? null : readTagWiki(data, name);
  }

  /** A creator's profile; null when there is no such creator. Cached a day. */
  async userProfile(name: string, { priority, signal }: Pick<GetOptions, 'priority' | 'signal'> = {}): Promise<UserProfile | null> {
    const data = await this.getJsonOrNull(`/v1/users/${encodeURIComponent(name)}`, {}, { ttlMs: DAY_MS, priority, signal });
    return data === null ? null : readUserProfile(data, name);
  }

  /** One page of niches (the booru's pools). Cached an hour. */
  async niches(
    { count = 50, page = 1 }: { count?: number; page?: number } = {},
    { priority, signal }: Pick<GetOptions, 'priority' | 'signal'> = {},
  ): Promise<NichesPage> {
    const data = await this.getJson<unknown>('/v2/niches', { count, page }, { ttlMs: HOUR_MS, priority, signal });
    return readNichesPage(data, page);
  }

  /** One niche; null when there is no such niche. Cached a day. */
  async niche(id: string, { priority, signal }: Pick<GetOptions, 'priority' | 'signal'> = {}): Promise<Niche | null> {
    const data = await this.getJsonOrNull(`/v2/niches/${encodeURIComponent(id)}`, {}, { ttlMs: DAY_MS, priority, signal });
    return data === null ? null : readNiche(data);
  }

  /**
   * One page of a niche's posts, same shape as searchGifs; ads (boosted/promoted) are dropped.
   * There is no `tags` parameter (filter client-side) and the total is not capped. Cached an hour.
   * Defaults: order trending, 100 per page. Callers that cannot know whether RedGifs accepts
   * 'trending' use fetchNichePage (nicheOrder.ts).
   */
  async nicheGifs(
    id: string,
    { order = 'trending', count = 100, page = 1 }: Pick<SearchParams, 'order' | 'count' | 'page'> = {},
    { signal, priority }: Pick<GetOptions, 'signal' | 'priority'> = {},
  ): Promise<SearchPage> {
    const data = await this.getJson<Record<string, unknown>>(`/v2/niches/${encodeURIComponent(id)}/gifs`, {
      order,
      count,
      page,
    }, { ttlMs: HOUR_MS, signal, priority });
    return {
      gifs: (data.gifs as Gif[] | undefined) ?? [],
      page: Number(data.page) || page,
      pages: Number(data.pages) || 0,
      total: Number(data.total) || 0,
      users: (data.users as User[] | undefined) ?? [],
    };
  }

  /** A single post. Reading it does not count a view. */
  async getGif(id: string): Promise<{ gif: Gif; user: User | null }> {
    const data = await this.getJson<{ gif: Gif; user?: User }>(`/v2/gifs/${encodeURIComponent(id)}`, {
      users: 'yes',
      niches: 'yes',
    });
    return { gif: data.gif, user: data.user ?? null };
  }

  /** RedGifs' spelling of a tag (e.g. "Big Tits" for "big_tits"), or null when it is not a tag. */
  async matchTag(name: string): Promise<string | null> {
    const key = normalizeTag(name);
    if (!key) return null;
    const data = await this.getJson<unknown>('/v1/tags/match', { query: key }, { ttlMs: DAY_MS });
    if (!Array.isArray(data)) return null;
    const hit = data.find((entry) => typeof entry === 'string' && normalizeTag(entry) === key);
    return typeof hit === 'string' ? hit : null;
  }

  /** Tag suggestions for a typed fragment, with RedGifs' global post count for each. */
  async suggestTags(fragment: string, { priority }: Pick<GetOptions, 'priority'> = {}): Promise<TagSuggestion[]> {
    const data = await this.getJson<unknown>('/v2/search/suggest', { query: fragment }, { ttlMs: DAY_MS, priority });
    if (!Array.isArray(data)) return [];
    const out: TagSuggestion[] = [];
    for (const entry of data as Array<{ type?: unknown; text?: unknown; gifs?: unknown } | null>) {
      if (entry?.type === 'tag' && typeof entry.text === 'string') {
        out.push({ text: entry.text, count: Number(entry.gifs) || 0 });
      }
    }
    return out;
  }
}
