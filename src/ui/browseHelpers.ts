// Pure helpers for the phase 4 pages: popular, pools, wiki, creator.
import type { PopularScale } from '../router';
import { resolveAlias } from '../search/aliases';
import { CATEGORIES, parseCategoryText, type Category } from '../search/categories';
import type { ServerOrder } from '../search/query';
import { normalizeTag } from '../search/tags';

// ------------------------------------------------------------------ popular

/** day -> trending, week -> top7, month -> top28. */
export const POPULAR_ORDER: Readonly<Record<PopularScale, ServerOrder>> = {
  day: 'trending',
  week: 'top7',
  month: 'top28',
};

export const POPULAR_LABEL: Readonly<Record<PopularScale, string>> = { day: 'Day', week: 'Week', month: 'Month' };

/** The search text of a popular tab: empty for trending (the default order), else `order:top7` / `order:top28`. */
export function popularTags(scale: PopularScale): string {
  const order = POPULAR_ORDER[scale];
  return order === 'trending' ? '' : `order:${order}`;
}

// ------------------------------------------------------------------ pools

export const POOLS_PER_PAGE = 50;

export interface PoolsPaging {
  /** The requested page, kept within 1..pages once the page count is known. */
  page: number;
  /** Known page count (0 until the first answer). */
  pages: number;
  prev: number | null;
  next: number | null;
}

/** Page numbers for the pools table from the `pages` RedGifs reported (the Paginator draws the numbers). */
export function poolsPaging(requested: number, pages: number): PoolsPaging {
  const known = Math.max(0, Math.floor(pages) || 0);
  const wanted = Math.max(1, Math.floor(requested) || 1);
  const page = known > 0 ? Math.min(wanted, known) : wanted;
  return {
    page,
    pages: known,
    prev: page > 1 ? page - 1 : null,
    next: known > 0 && page < known ? page + 1 : null,
  };
}

// ------------------------------------------------------------------ wiki

/** Keys of the aliases that end up at `key` (after following chains), sorted. */
export function aliasesPointingTo(map: ReadonlyMap<string, string>, key: string): string[] {
  const out: string[] = [];
  for (const from of map.keys()) {
    if (from !== key && resolveAlias(from, map) === key) out.push(from);
  }
  return out.sort();
}

/**
 * The user's category text with `key` set to `category` (one line per tag, any earlier line for the
 * tag removed), or with the override removed when `category` is null. Comments and other lines stay.
 */
export function setCategoryOverride(text: string, key: string, category: Category | null): string {
  const k = normalizeTag(key);
  const kept = String(text ?? '').split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return true;
    const m = /^(.*):\s*([A-Za-z]+)\s*$/.exec(trimmed);
    return !(m && normalizeTag(m[1]) === k);
  });
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  if (category !== null && k) kept.push(`${k}: ${category}`);
  return kept.length ? `${kept.join('\n')}\n` : '';
}

/** Whether the user's text overrides the category of `key`. */
export function hasCategoryOverride(text: string, key: string): boolean {
  return normalizeTag(key) in parseCategoryText(text);
}

/** The categories a user may pick in the wiki (creator is reserved for the post's creator). */
export const PICKABLE_CATEGORIES: readonly Category[] = CATEGORIES.filter((c) => c !== 'creator');

/** Posts that carry the tag itself (exact, ignoring case / underscores), at most `limit`. */
export function postsWithTag<T extends { tags: string[] }>(gifs: T[], key: string, limit = 12): T[] {
  const k = normalizeTag(key);
  return gifs.filter((g) => g.tags.some((t) => normalizeTag(t) === k)).slice(0, limit);
}

// ------------------------------------------------------------------ creator

/** Only http(s) links are shown from a profile. */
export function safeLink(url: string): string | null {
  try {
    const u = new URL(url.includes('://') ? url : `https://${url}`);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}
