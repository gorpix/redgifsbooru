import { createChannel, defaultStorage, readJson, readText, stringList, writeJson, writeText, type KeyValueStorage } from './storage';

export const BLACKLIST_KEY = 'rgb:blacklist';
export const BLACKLIST_PAUSED_KEY = 'rgb:blacklist-paused';

const channel = createChannel([BLACKLIST_KEY, BLACKLIST_PAUSED_KEY]);

/** Raw blacklist text in RedGIFS-X format (entries split by commas or newlines). */
export function getBlacklistText(storage: KeyValueStorage | null = defaultStorage()): string {
  return readText(BLACKLIST_KEY, storage) ?? '';
}

export function setBlacklistText(text: string, storage: KeyValueStorage | null = defaultStorage()): void {
  writeText(BLACKLIST_KEY, text, storage);
  channel.notify();
}

/** Rule keys (`mode:value`) the user paused without deleting. */
export function getPausedKeys(storage: KeyValueStorage | null = defaultStorage()): string[] {
  return stringList(readJson(BLACKLIST_PAUSED_KEY, storage));
}

export function setPausedKeys(keys: string[], storage: KeyValueStorage | null = defaultStorage()): void {
  writeJson(BLACKLIST_PAUSED_KEY, [...new Set(keys)], storage);
  channel.notify();
}

export const subscribeBlacklist = channel.subscribe;
