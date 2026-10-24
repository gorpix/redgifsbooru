// Tag categories (e621 style): which group a tag is listed under on the post page.
// Built-in guesses live in builtinCategories.ts; the user can override any tag in settings.
import type { MergeIndex } from './merges';
import { normalizeTag } from './tags';

export type Category = 'creator' | 'body' | 'act' | 'setting' | 'meta' | 'general';

/** Every valid category name (creator is only used for the post's userName, but may be parsed). */
export const CATEGORIES: readonly Category[] = ['creator', 'body', 'act', 'setting', 'meta', 'general'];

/** Order of the tag groups in the sidebar, after the Creator group (which always comes first). */
export const CATEGORY_ORDER: readonly Category[] = ['body', 'act', 'setting', 'general', 'meta'];

export const CATEGORY_LABEL: Readonly<Record<Category, string>> = {
  creator: 'Creator',
  body: 'Body',
  act: 'Acts',
  setting: 'Setting',
  general: 'General',
  meta: 'Meta',
};

/** Tag colours, readable on the dark-red theme; creator amber like e621's artist. */
export const CATEGORY_COLOR: Readonly<Record<Category, string>> = {
  creator: '#f2ac08',
  body: '#ff8fb8',
  act: '#7fd96f',
  setting: '#6fc3ff',
  general: '#e4d6d8',
  meta: '#c3a6ff',
};

export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

const hasOwn = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * User overrides: one `tag: category` per line, `#` starts a comment line. Tags are normalized
 * (underscores, spaces and case do not matter). Lines with an unknown category or no tag are skipped;
 * a later line for the same tag wins.
 */
export function parseCategoryText(text: string): Record<string, Category> {
  const out: Record<string, Category> = Object.create(null);
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = /^(.*):\s*([A-Za-z]+)\s*$/.exec(trimmed);
    if (!m) continue;
    const key = normalizeTag(m[1]);
    const category = m[2].toLowerCase();
    if (key && isCategory(category)) out[key] = category;
  }
  return out;
}

/**
 * Category of a tag. The user's setting wins over the built-in one; for each of them the tag's own
 * key is tried first, then its merge-canonical key (when `index` is given). Default 'general'.
 */
export function categoryOf(
  key: string,
  builtin: Readonly<Record<string, Category>>,
  user: Readonly<Record<string, Category>>,
  index?: MergeIndex,
): Category {
  const own = normalizeTag(key);
  const keys = index ? [own, index.canonical(own)] : [own];
  for (const table of [user, builtin]) {
    for (const k of keys) {
      if (hasOwn(table, k)) return table[k];
    }
  }
  return 'general';
}
