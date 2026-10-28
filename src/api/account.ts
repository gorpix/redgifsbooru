// Account endpoints (likes, follows, collections = sets). Thin wrappers over RedgifsApi: reads
// go through getJson (personalized, so never in the IndexedDB cache), writes through send().
// Shapes are not documented, so every reader is defensive and never throws.
import type { RedgifsApi } from './client';
import { HttpError } from './http';
import { readUserProfile } from './normalize';
import type { Collection, CollectionsPage, FollowingPage, Gif, Me, SearchPage, User } from './types';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

const enc = encodeURIComponent;
const LIKE_BODY = { context: 'booru', source: 'booru', source_id: null, position: 0 };
const FOLLOW_BODY = { source: 'booru', source_id: null, position: 1 };

export function readMe(data: unknown): Me {
  const o = isObj(data) ? data : {};
  return {
    username: str(o.username),
    name: str(o.name),
    description: str(o.description),
    profileUrl: str(o.profileUrl),
    profileImageUrl: str(o.profileImageUrl),
    blockedTags: Array.isArray(o.blockedTags) ? o.blockedTags.filter((t): t is string => typeof t === 'string' && t.trim() !== '') : [],
  };
}

export function readCollection(data: unknown, fallbackId = ''): Collection | null {
  const root = isObj(data) ? data : null;
  if (!root) return null;
  const o = isObj(root.collection) ? root.collection : root;
  const id = str(o.folderId) ?? str(o.id) ?? str(o.collectionId) ?? (fallbackId || null);
  if (!id) return null;
  const thumbs = Array.isArray(o.thumbs)
    ? o.thumbs
        .map((t) => (typeof t === 'string' ? t : isObj(t) ? str(t.url) ?? str(t.thumbnail) ?? str(t.thumb) : null))
        .filter((t): t is string => typeof t === 'string' && t !== '')
    : [];
  let count: number | null = null;
  for (const key of ['contentCount', 'gifsCount', 'gifCount', 'itemCount', 'count', 'gifs']) {
    const n = Array.isArray(o[key]) ? (o[key] as unknown[]).length : num(o[key]);
    if (n !== null) { count = n; break; }
  }
  return {
    id,
    name: str(o.folderName) ?? str(o.name) ?? id,
    description: str(o.description),
    published: o.published === true,
    thumbs,
    count,
  };
}

export function readCollectionsPage(data: unknown, page: number): CollectionsPage {
  const o = isObj(data) ? data : {};
  const list = Array.isArray(o.collections) ? o.collections : Array.isArray(o.items) ? o.items : [];
  const collections = list.map((c) => readCollection(c)).filter((c): c is Collection => c !== null);
  return {
    collections,
    page: num(o.page) ?? page,
    pages: num(o.pages) ?? (collections.length ? 1 : 0),
    total: num(o.totalCount) ?? num(o.total) ?? collections.length,
  };
}

/** A feed (`gifs`, `page`, `pages`, `total`) as the same SearchPage the rest of the booru uses. */
export function readFeedPage(data: unknown, page: number): SearchPage {
  const o = isObj(data) ? data : {};
  const gifs = Array.isArray(o.gifs) ? (o.gifs.filter((g) => isObj(g) && typeof g.id === 'string') as unknown as Gif[]) : [];
  return {
    gifs,
    page: num(o.page) ?? page,
    pages: num(o.pages) ?? 0,
    total: num(o.total) ?? num(o.totalCount) ?? gifs.length,
    users: Array.isArray(o.users) ? (o.users.filter(isObj) as unknown as User[]) : [],
  };
}

function readNames(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  const out: string[] = [];
  for (const item of data) {
    const name = typeof item === 'string' ? item : isObj(item) ? str(item.username) : null;
    if (name) out.push(name);
  }
  return out;
}

export interface CollectionFields {
  folderName: string;
  description: string | null;
  published: boolean;
}

export class AccountApi {
  constructor(private readonly api: RedgifsApi) {}

  /** `/v1/me`. Throws on 401 (not logged in). */
  async me(): Promise<Me> {
    return readMe(await this.api.getJson<unknown>('/v1/me', {}, { ttlMs: 60_000 }));
  }

  // ---- likes -------------------------------------------------------------------------

  /** Every liked gif id. */
  async likedIds(): Promise<string[]> {
    const data = await this.api.getJson<unknown>('/v2/likes', {}, { ttlMs: 60_000 });
    return Array.isArray(data) ? data.filter((id): id is string => typeof id === 'string' && id !== '') : [];
  }

  async like(id: string): Promise<void> {
    await this.api.send('PUT', `/v2/gifs/${enc(id)}/like`, LIKE_BODY);
  }

  async unlike(id: string): Promise<void> {
    await this.api.send('DELETE', `/v2/gifs/${enc(id)}/like`, { context: 'booru' });
  }

  /** One page of my liked posts, same shape as searchGifs. `type` g = videos, i = images. */
  async likedFeed(
    { page = 1, count = 30, type = 'g' }: { page?: number; count?: number; type?: 'g' | 'i' } = {},
    { signal, priority }: { signal?: AbortSignal; priority?: 'high' | 'low' } = {},
  ): Promise<SearchPage> {
    const data = await this.api.getJson<unknown>('/v2/feeds/liked', { page, count, type }, { ttlMs: 60_000, signal, priority });
    return readFeedPage(data, page);
  }

  // ---- follows -----------------------------------------------------------------------

  /** Usernames I follow. */
  async followedNames(): Promise<string[]> {
    return readNames(await this.api.getJson<unknown>('/v1/me/follows', {}, { ttlMs: 60_000 }));
  }

  async follow(name: string): Promise<void> {
    await this.api.send('PUT', `/v1/me/follows/${enc(name)}`, FOLLOW_BODY);
  }

  async unfollow(name: string): Promise<void> {
    await this.api.send('DELETE', `/v1/me/follows/${enc(name)}`);
  }

  async following({ page = 1, count = 100 }: { page?: number; count?: number } = {}): Promise<FollowingPage> {
    const data = await this.api.getJson<unknown>('/v2/me/following', { count, page }, { ttlMs: 60_000 });
    const o = isObj(data) ? data : {};
    const list = Array.isArray(o.items) ? o.items : Array.isArray(o.users) ? o.users : [];
    const items = list.filter(isObj).map((p) => readUserProfile(p, ''));
    return {
      items: items.filter((p) => p.username !== ''),
      page: num(o.page) ?? page,
      pages: num(o.pages) ?? (items.length ? 1 : 0),
      total: num(o.total) ?? items.length,
    };
  }

  // ---- collections (sets) ------------------------------------------------------------

  async collections({ page = 1, count = 50 }: { page?: number; count?: number } = {}): Promise<CollectionsPage> {
    const data = await this.api.getJson<unknown>('/v2/me/collections', { count, page }, { ttlMs: 60_000 });
    return readCollectionsPage(data, page);
  }

  /** One collection; null when it does not exist. */
  async collection(id: string): Promise<Collection | null> {
    try {
      return readCollection(await this.api.getJson<unknown>(`/v2/me/collections/${enc(id)}`, {}, { ttlMs: 60_000 }), id);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
  }

  /** One page of a collection's posts, same shape as searchGifs. */
  async collectionGifs(
    id: string,
    { page = 1, count = 100 }: { page?: number; count?: number } = {},
    { signal, priority }: { signal?: AbortSignal; priority?: 'high' | 'low' } = {},
  ): Promise<SearchPage> {
    const data = await this.api.getJson<unknown>(`/v2/me/collections/${enc(id)}/gifs`, { count, page }, { ttlMs: 60_000, signal, priority });
    return readFeedPage(data, page);
  }

  async createCollection({ folderName, description = null, published = false }: { folderName: string; description?: string | null; published?: boolean }): Promise<Collection> {
    const data = await this.api.send<unknown>('POST', '/v2/me/collections', { folderName, description, published });
    return readCollection(data) ?? { id: '', name: folderName, description, published, thumbs: [], count: 0 };
  }

  /** PATCH with the full field set; fields you leave out are filled from the current collection. */
  async updateCollection(id: string, patch: Partial<CollectionFields>): Promise<void> {
    let current: Partial<CollectionFields> = patch;
    if (patch.folderName === undefined || patch.description === undefined || patch.published === undefined) {
      const existing = await this.collection(id);
      current = {
        folderName: existing?.name ?? id,
        description: existing?.description ?? null,
        published: existing?.published ?? false,
        ...patch,
      };
    }
    await this.api.send('PATCH', `/v2/me/collections/${enc(id)}`, {
      collectionId: id,
      folderName: current.folderName,
      description: current.description ?? null,
      published: current.published ?? false,
    });
  }

  async deleteCollection(id: string): Promise<void> {
    await this.api.send('DELETE', `/v2/me/collections/${enc(id)}`);
  }

  /** Adds one post (RedGifs takes one per call). */
  async addToCollection(id: string, gifId: string): Promise<void> {
    await this.api.send('POST', `/v2/me/collections/${enc(id)}/gifs`, { gifId, context: 'booru' });
  }

  async removeFromCollection(id: string, gifIds: string[]): Promise<void> {
    await this.api.send('DELETE', `/v2/me/collections/${enc(id)}/gifs`, gifIds);
  }
}
