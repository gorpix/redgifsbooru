// Response cache in IndexedDB, with an in-memory fallback when IndexedDB is
// unavailable (private windows, blocked storage).

export interface ResponseCache {
  get<T>(key: string, maxAgeMs: number): Promise<T | undefined>;
  set<T>(key: string, data: T): Promise<void>;
  clear(): Promise<void>;
}

interface CacheEntry<T = unknown> {
  key: string;
  data: T;
  storedAt: number;
}

const DB_NAME = 'redgifsbooru';
const STORE = 'responses';
const PRUNE_EVERY_WRITES = 50;
const PRUNE_ABOVE_ENTRIES = 2000;
const PRUNE_OLDER_THAN_MS = 7 * 24 * 60 * 60 * 1000;

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class MemoryCache implements ResponseCache {
  private entries = new Map<string, CacheEntry>();
  constructor(private readonly now: () => number = Date.now) {}

  async get<T>(key: string, maxAgeMs: number): Promise<T | undefined> {
    const entry = this.entries.get(key);
    if (!entry || this.now() - entry.storedAt > maxAgeMs) return undefined;
    return entry.data as T;
  }

  async set<T>(key: string, data: T): Promise<void> {
    this.entries.set(key, { key, data, storedAt: this.now() });
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }
}

export class IdbCache implements ResponseCache {
  private db: Promise<IDBDatabase> | null = null;
  private writes = 0;

  constructor(
    private readonly idb: IDBFactory = indexedDB,
    private readonly now: () => number = Date.now,
  ) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const request = this.idb.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('storedAt', 'storedAt');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.db;
  }

  private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await this.open()).transaction(STORE, mode).objectStore(STORE);
  }

  async get<T>(key: string, maxAgeMs: number): Promise<T | undefined> {
    const entry = (await promisify((await this.store('readonly')).get(key))) as CacheEntry<T> | undefined;
    if (!entry || this.now() - entry.storedAt > maxAgeMs) return undefined;
    return entry.data;
  }

  async set<T>(key: string, data: T): Promise<void> {
    await promisify((await this.store('readwrite')).put({ key, data, storedAt: this.now() }));
    this.writes += 1;
    if (this.writes % PRUNE_EVERY_WRITES === 0) await this.prune();
  }

  /** Once the store is large, drops entries older than a week. */
  async prune(): Promise<void> {
    const store = await this.store('readwrite');
    if ((await promisify(store.count())) < PRUNE_ABOVE_ENTRIES) return;
    const range = IDBKeyRange.upperBound(this.now() - PRUNE_OLDER_THAN_MS);
    const keys = await promisify(store.index('storedAt').getAllKeys(range));
    await Promise.all(keys.map((key) => promisify(store.delete(key))));
  }

  async clear(): Promise<void> {
    await promisify((await this.store('readwrite')).clear());
  }
}

/** IndexedDB when it opens, otherwise memory. */
export async function createCache(idb: IDBFactory | undefined = globalThis.indexedDB): Promise<ResponseCache> {
  if (!idb) return new MemoryCache();
  try {
    const cache = new IdbCache(idb);
    await cache.get('probe', 0);
    return cache;
  } catch {
    return new MemoryCache();
  }
}
