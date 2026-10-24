// Pure helpers for the post page.
import type { Gif } from '../api/types';
import type { MergeIndex } from '../search/merges';
import { normalizeTag } from '../search/tags';

/** The posts next to `id` within one page's list; either is undefined at an edge or when `id` is not in the list. */
export function neighbours(posts: readonly Gif[], id: string): { prev?: Gif; next?: Gif } {
  const i = posts.findIndex((g) => g.id === id);
  if (i < 0) return {};
  return { prev: posts[i - 1], next: posts[i + 1] };
}

/** Tags with fewer posts than this are too narrow to find related posts with. */
export const MIN_DISTINCTIVE_COUNT = 500;

/**
 * The (up to) `n` most distinctive tags of a post, as merge-canonical normalized keys, for the
 * "Related" row. Distinctive = lowest known global count that is still >= 500 (rarer tags match
 * almost nothing, so they are skipped). Ties keep the post's tag order. When fewer than `n` tags
 * qualify, the list is topped up with tags whose count is unknown (post order), then with any
 * remaining tags (post order); so with no counts at all it is simply the first `n` tags.
 * `countOf(key)`: the global count, null when RedGifs has none, undefined while unknown. It is
 * called with canonical keys (use groupGlobalCount to sum a merge group if wanted).
 */
export function distinctiveTags(
  gifTags: readonly string[],
  mergeIndex: MergeIndex,
  countOf: (key: string) => number | null | undefined,
  n = 2,
): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const raw of gifTags) {
    const key = mergeIndex.canonical(normalizeTag(raw));
    if (key && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  const counts = new Map(keys.map((k) => [k, countOf(k)] as const));
  const known = keys
    .filter((k) => (counts.get(k) ?? -1) >= MIN_DISTINCTIVE_COUNT)
    .map((k, order) => ({ k, order, count: counts.get(k) as number }))
    .sort((a, b) => a.count - b.count || a.order - b.order)
    .map((x) => x.k);
  const unknown = keys.filter((k) => counts.get(k) === undefined || counts.get(k) === null);
  const rest = keys.filter((k) => !known.includes(k) && !unknown.includes(k));
  return [...known, ...unknown, ...rest].slice(0, n);
}

const UNITS: ReadonlyArray<[label: string, seconds: number]> = [
  ['year', 365 * 86400],
  ['month', 30 * 86400],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

/** "3 days ago" style age of a post created at `createDateSeconds` (unix s), measured at `nowMs`. */
export function formatAge(createDateSeconds: number, nowMs: number): string {
  if (!Number.isFinite(createDateSeconds)) return '';
  const seconds = Math.floor(nowMs / 1000 - createDateSeconds);
  for (const [label, size] of UNITS) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `${n} ${label}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}
