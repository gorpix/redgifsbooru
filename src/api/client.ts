// Every RedGifs API call goes through here: guard, cache, queue, token,
// retries and rate-limit backoff. When RedGifs changes, this is where to fix.
import type { ResponseCache } from './cache';
import { API_ROOT, isForbiddenUrl } from './guard';
import { ForbiddenEndpointError, HttpError, RateLimitedError, type Transport } from './http';
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
  tokens?: TokenManager;
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

    if (ttlMs > 0 && this.cache) {
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

    // Timing and outcome for the debug hook (onRequest). Uses the injected clock.
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

    entry.promise = this.queue.run(() => {
      entry.started = true;
      startedAt = this.clock.now();
      return this.request<T>(url, context);
    }, { priority, signal: controller.signal }).then(
      async (data) => {
        report('ok');
        if (this.cache) await this.cache.set(url, data).catch(() => undefined);
        return data;
      },
      (error: unknown) => {
        report(startedAt === undefined ? 'aborted' : 'error', error);
        throw error;
      },
    ).finally(() => {
      if (this.inFlight.get(url) === entry) this.inFlight.delete(url);
    });
    this.inFlight.set(url, entry);
    return entry;
  }

  private async request<T>(url: string, context: RequestContext): Promise<T> {
    let authFailures = 0;
    let rateLimitHits = 0;
    let transientFailures = 0;
    let refresh = false;

    for (;;) {
      const token = await this.tokens.get(refresh);
      refresh = false;
      let status: number;
      let text = '';
      try {
        ({ status, text } = await this.transport({
          url,
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
          timeoutMs: this.timeoutMs,
        }));
      } catch (error) {
        if (transientFailures++ >= MAX_TRANSIENT_RETRIES) throw error;
        await this.clock.sleep(TRANSIENT_RETRY_MS);
        continue;
      }

      if (status >= 200 && status < 300) {
        if (this.status.rateLimitedUntil) this.setStatus({ rateLimitedUntil: 0, gaveUp: false });
        return JSON.parse(text) as T;
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
