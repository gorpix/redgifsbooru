// Matching posts against a parsed query and the blacklist; page sorting.
import type { Gif } from '../api/types';
import { genderOf, type ImplicationMap } from './implications';
import type { MergeIndex } from './merges';
import type { MetaFilter, PageSort, Query } from './query';
import { normalizeTag } from './tags';

export interface BlacklistRule {
  mode: 'exact' | 'partial';
  value: string;
  /** `${mode}:${value}` */
  key: string;
}

export type Rejection = 'blacklist' | 'untagged' | 'ungendered' | 'exclude' | 'required' | 'any' | 'meta';

/** Content filters applied right after the blacklist. */
export interface ContentFilters {
  hideUntagged: boolean;
  hideUngendered: boolean;
  /** Needed for hideUngendered (built-ins + user lines, see buildImplicationMap). */
  implications?: ImplicationMap;
}

export function parseBlacklist(text: string): BlacklistRule[] {
  const rules: BlacklistRule[] = [];
  const seen = new Set<string>();
  for (const entry of String(text ?? '').split(/[,\n]+/)) {
    let s = entry.trim();
    let partial = false;
    // Leading `*` means partial; leading `-` is stripped (still exact).
    const lead = /^[-*]+/.exec(s);
    if (lead) {
      partial = lead[0].includes('*');
      s = s.slice(lead[0].length).trim();
    }
    const quoted = /^(["'])(.*)\1$/.exec(s);
    if (quoted) s = quoted[2];
    const value = normalizeTag(s);
    if (!value) continue;
    const mode = partial ? 'partial' : 'exact';
    const key = `${mode}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push({ mode, value, key });
  }
  return rules;
}

/** Typical like rate of an established post (median 0.27 %, measured 2026-10-25). */
const SCORE_P0 = 0.0025;
/** Prior strength in views: a post needs a few thousand views before its own rate dominates. */
const SCORE_M = 2000;

/**
 * 0-100 integer: favourites per view relative to a typical post. 50 = typical, +25 = twice as many
 * (log2 scale). The rate is smoothed toward the typical one, so a post with 0 views scores 50.
 * null when views (or likes) is not a finite number.
 */
export function favoriteScore(gif: Pick<Gif, 'likes' | 'views'>): number | null {
  const { likes, views } = gif;
  if (typeof views !== 'number' || !Number.isFinite(views)) return null;
  if (typeof likes !== 'number' || !Number.isFinite(likes)) return null;
  const smoothed = (Math.max(0, likes) + SCORE_M * SCORE_P0) / (Math.max(0, views) + SCORE_M);
  const score = Math.round(50 + 25 * Math.log2(smoothed / SCORE_P0));
  return Math.min(100, Math.max(0, score));
}

function createSeconds(gif: Gif): number | null {
  const d = gif.createDate;
  if (typeof d !== 'number' || !Number.isFinite(d)) return null;
  return d > 1e12 ? d / 1000 : d;
}

function comparedValue(gif: Gif, filter: MetaFilter, nowSeconds: number): number | null {
  switch (filter.field) {
    case 'views':
      return gif.views;
    case 'favs':
      return gif.likes;
    case 'score':
      return favoriteScore(gif);
    default: {
      const created = createSeconds(gif);
      if (created === null) return null;
      return filter.kind === 'age' ? nowSeconds - created : created;
    }
  }
}

function passesMeta(gif: Gif, filter: MetaFilter, nowSeconds: number): boolean {
  const v = comparedValue(gif, filter, nowSeconds);
  if (typeof v !== 'number' || !Number.isFinite(v)) return true;
  const aboveMin = filter.minInclusive ? v >= filter.min : v > filter.min;
  const belowMax = filter.maxInclusive ? v <= filter.max : v < filter.max;
  return aboveMin && belowMax;
}

export function checkGif(
  gif: Gif,
  query: Query,
  blacklist: BlacklistRule[],
  nowSeconds: number,
  index?: MergeIndex,
  filters?: ContentFilters,
): Rejection | null {
  const hasTags = Array.isArray(gif.tags);
  const keys = hasTags ? gif.tags.map(normalizeTag) : [];
  // Exact comparisons see merged tags as their canonical key; partial ones use the raw keys.
  const keySet = new Set(index ? keys.map((k) => index.canonical(k)) : keys);
  const hits = (mode: 'exact' | 'partial', value: string) =>
    mode === 'exact' ? keySet.has(value) : keys.some((k) => k.includes(value));

  if (blacklist.some((r) => hits(r.mode, r.value))) return 'blacklist';
  if (filters?.hideUntagged && keys.length === 0) return 'untagged';
  if (filters?.hideUngendered && filters.implications && genderOf(gif.tags, gif.sexuality, filters.implications, index).size === 0) {
    return 'ungendered';
  }
  if (query.exclusions.some((e) => hits(e.mode, e.value))) return 'exclude';
  if (hasTags) {
    if (!query.required.every((k) => keySet.has(k))) return 'required';
    if (query.any.length > 0 && !query.any.some((k) => keySet.has(k))) return 'any';
  }
  if (!query.meta.every((f) => passesMeta(gif, f, nowSeconds))) return 'meta';
  return null;
}

function sortKey(gif: Gif, sort: PageSort): number | null {
  const v = sort.startsWith('views')
    ? gif.views
    : sort.startsWith('favs')
      ? gif.likes
      : sort.startsWith('score')
        ? favoriteScore(gif)
        : gif.createDate;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function sortPage(gifs: Gif[], sort: PageSort): Gif[] {
  const dir = sort.endsWith('-asc') ? 1 : -1;
  return gifs
    .map((gif, index) => ({ gif, index, key: sortKey(gif, sort) }))
    .sort((a, b) => {
      if (a.key === null || b.key === null) {
        if (a.key === b.key) return a.index - b.index;
        return a.key === null ? 1 : -1;
      }
      return dir * (a.key - b.key) || a.index - b.index;
    })
    .map((x) => x.gif);
}
