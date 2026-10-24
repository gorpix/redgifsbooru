import { createChannel, defaultStorage, readJson, writeJson, type KeyValueStorage } from './storage';

export interface SavedSearch {
  name: string;
  query: string;
}

export const SAVED_KEY = 'rgb:saved-searches';

const channel = createChannel([SAVED_KEY]);

export function getSavedSearches(storage: KeyValueStorage | null = defaultStorage()): SavedSearch[] {
  const raw = readJson(SAVED_KEY, storage);
  if (!Array.isArray(raw)) return [];
  const out: SavedSearch[] = [];
  for (const item of raw) {
    if (item && typeof item.name === 'string' && typeof item.query === 'string' && item.query.trim()) {
      out.push({ name: item.name, query: item.query });
    }
  }
  return out;
}

/** Saves a search; an existing one with the same query is replaced and moved to the end. */
export function saveSearch(name: string, query: string, storage: KeyValueStorage | null = defaultStorage()): SavedSearch[] {
  const q = query.trim();
  if (!q) return getSavedSearches(storage);
  const list = getSavedSearches(storage).filter((s) => s.query !== q);
  list.push({ name: name.trim() || q, query: q });
  writeJson(SAVED_KEY, list, storage);
  channel.notify();
  return list;
}

export function removeSavedSearch(query: string, storage: KeyValueStorage | null = defaultStorage()): SavedSearch[] {
  const q = query.trim();
  const list = getSavedSearches(storage).filter((s) => s.query !== q);
  writeJson(SAVED_KEY, list, storage);
  channel.notify();
  return list;
}

export const subscribeSaved = channel.subscribe;
