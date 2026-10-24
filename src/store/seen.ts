// Ids of posts the user has opened, lowercase, newest last, capped at 5000.
import { createChannel, defaultStorage, readJson, stringList, writeJson, type KeyValueStorage } from './storage';

export const SEEN_KEY = 'rgb:seen';
export const MAX_SEEN = 5000;

const channel = createChannel([SEEN_KEY]);
// Parsed copy per storage object, so isSeen is cheap when called for every thumbnail.
const caches = new WeakMap<object, Set<string>>();

function readList(storage: KeyValueStorage | null): string[] {
  return stringList(readJson(SEEN_KEY, storage)).map((id) => id.toLowerCase());
}

function cacheFor(storage: KeyValueStorage | null): Set<string> {
  const known = storage ? caches.get(storage) : undefined;
  if (known) return known;
  const set = new Set(readList(storage));
  if (storage) caches.set(storage, set);
  return set;
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  // Another tab wrote: drop our parsed copy.
  window.addEventListener('storage', (event) => {
    if (event.key === SEEN_KEY || event.key === null) {
      const storage = defaultStorage();
      if (storage) caches.delete(storage);
    }
  });
}

export function isSeen(id: string, storage: KeyValueStorage | null = defaultStorage()): boolean {
  return cacheFor(storage).has(String(id).toLowerCase());
}

/** Adds ids, merging with what is in storage right now, keeping the newest 5000. Returns how many were new. */
export function mergeSeen(ids: string[], storage: KeyValueStorage | null = defaultStorage()): number {
  const list = readList(storage);
  const have = new Set(list);
  let added = 0;
  for (const raw of ids) {
    const id = String(raw).toLowerCase();
    if (!id || have.has(id)) continue;
    have.add(id);
    list.push(id);
    added += 1;
  }
  if (added === 0) {
    if (storage) caches.set(storage, have);
    return 0;
  }
  const kept = list.slice(-MAX_SEEN);
  writeJson(SEEN_KEY, kept, storage);
  if (storage) caches.set(storage, new Set(kept));
  channel.notify();
  return added;
}

export function markSeen(id: string, storage: KeyValueStorage | null = defaultStorage()): void {
  mergeSeen([id], storage);
}

export const subscribeSeen = channel.subscribe;
