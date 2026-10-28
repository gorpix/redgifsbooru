import { createChannel, defaultStorage, readText, writeText, type KeyValueStorage } from './storage';

export const IMPLICATIONS_KEY = 'rgb:implications';

const channel = createChannel([IMPLICATIONS_KEY]);

/** Raw user implication text: one `tag -> female, male` per line. */
export function getImplicationText(storage: KeyValueStorage | null = defaultStorage()): string {
  return readText(IMPLICATIONS_KEY, storage) ?? '';
}

export function setImplicationText(text: string, storage: KeyValueStorage | null = defaultStorage()): void {
  writeText(IMPLICATIONS_KEY, text, storage);
  channel.notify();
}

export const subscribeImplications = channel.subscribe;
