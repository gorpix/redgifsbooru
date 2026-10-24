import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { IdbCache, MemoryCache, createCache, type ResponseCache } from '../src/api/cache';

function suite(name: string, make: (now: () => number) => ResponseCache) {
  describe(name, () => {
    it('returns undefined for a missing key', async () => {
      expect(await make(() => 0).get('nope', 1000)).toBeUndefined();
    });

    it('stores and returns values', async () => {
      const cache = make(() => 0);
      await cache.set('k', { a: [1, 2] });
      expect(await cache.get('k', 1000)).toEqual({ a: [1, 2] });
    });

    it('overwrites an existing key', async () => {
      const cache = make(() => 0);
      await cache.set('k', 1);
      await cache.set('k', 2);
      expect(await cache.get('k', 1000)).toBe(2);
    });

    it('expires entries older than maxAge', async () => {
      let now = 100;
      const cache = make(() => now);
      await cache.set('k', 'v');
      now = 600;
      expect(await cache.get('k', 500)).toBe('v');
      expect(await cache.get('k', 499)).toBeUndefined();
      expect(await cache.get('k', 0)).toBeUndefined();
    });

    it('clear removes everything', async () => {
      const cache = make(() => 0);
      await cache.set('a', 1);
      await cache.set('b', 2);
      await cache.clear();
      expect(await cache.get('a', 1000)).toBeUndefined();
      expect(await cache.get('b', 1000)).toBeUndefined();
    });
  });
}

suite('MemoryCache', (now) => new MemoryCache(now));
suite('IdbCache', (now) => new IdbCache(new IDBFactory(), now));

describe('IdbCache.prune', () => {
  it('does nothing below the size threshold', async () => {
    const cache = new IdbCache(new IDBFactory(), () => 0);
    await cache.set('k', 1);
    await expect(cache.prune()).resolves.toBeUndefined();
    expect(await cache.get('k', 1000)).toBe(1);
  });

  it('runs on every 50th write without error', async () => {
    const cache = new IdbCache(new IDBFactory(), () => 0);
    for (let i = 0; i < 50; i++) await cache.set(`k${i}`, i);
    expect(await cache.get('k49', 1000)).toBe(49);
  });
});

describe('createCache', () => {
  it('returns a working IndexedDB-backed cache', async () => {
    const cache = await createCache(new IDBFactory());
    expect(cache).toBeInstanceOf(IdbCache);
    await cache.set('k', 'v');
    expect(await cache.get('k', 1000)).toBe('v');
  });

  it('returns a MemoryCache when indexedDB is undefined', async () => {
    // The default parameter reads globalThis.indexedDB, which fake-indexeddb/auto
    // installs; remove it to mimic a browser without IndexedDB.
    const g = globalThis as { indexedDB?: IDBFactory };
    const saved = g.indexedDB;
    delete g.indexedDB;
    try {
      const cache = await createCache(undefined);
      expect(cache).toBeInstanceOf(MemoryCache);
      await cache.set('k', 'v');
      expect(await cache.get('k', 1000)).toBe('v');
    } finally {
      g.indexedDB = saved;
    }
  });

  it('falls back to memory when IndexedDB fails to open', async () => {
    const broken = { open: () => { throw new Error('blocked'); } } as unknown as IDBFactory;
    expect(await createCache(broken)).toBeInstanceOf(MemoryCache);
  });
});
