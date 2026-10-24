import { createChannel, defaultStorage, readText, writeText, type KeyValueStorage } from './storage';

export const MERGES_KEY = 'rgb:merges';

const channel = createChannel([MERGES_KEY]);

/** Raw user merge text: one group per line, members separated by commas. */
export function getMergeText(storage: KeyValueStorage | null = defaultStorage()): string {
  return readText(MERGES_KEY, storage) ?? '';
}

export function setMergeText(text: string, storage: KeyValueStorage | null = defaultStorage()): void {
  writeText(MERGES_KEY, text, storage);
  channel.notify();
}

export const subscribeMerges = channel.subscribe;
