import { createChannel, defaultStorage, readText, writeText, type KeyValueStorage } from './storage';

export const CATEGORIES_KEY = 'rgb:tag-categories';

const channel = createChannel([CATEGORIES_KEY]);

/** Raw user category text: one `tag: category` per line (`#` comments). Parse with parseCategoryText. */
export function getCategoryText(storage: KeyValueStorage | null = defaultStorage()): string {
  return readText(CATEGORIES_KEY, storage) ?? '';
}

export function setCategoryText(text: string, storage: KeyValueStorage | null = defaultStorage()): void {
  writeText(CATEGORIES_KEY, text, storage);
  channel.notify();
}

export const subscribeCategories = channel.subscribe;
