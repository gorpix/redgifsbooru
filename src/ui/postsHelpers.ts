// Pure helpers for the posts index: filler keys, tag aggregation, status text.
import { RateLimitedError } from '../api/http';
import type { Gif } from '../api/types';
import type { FillState } from '../search/filler';
import { IDENTITY_INDEX, type MergeIndex } from '../search/merges';
import { formatQuery, type PageSort, type Query } from '../search/query';
import { normalizeTag, toTagTerm } from '../search/tags';

/** Short djb2 hash as hex. */
export function djb2Hex(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/** Where a grid's posts come from: the global search, one creator's posts, or one niche's posts. */
export type Source = { kind: 'search' } | { kind: 'user'; name: string } | { kind: 'niche'; id: string };

export const SEARCH_SOURCE: Source = { kind: 'search' };

/** Stable text for a source; '' for the global search so its filler ids stay as they were. */
export function sourceKey(source: Source): string {
  switch (source.kind) {
    case 'search': return '';
    case 'user': return `user:${source.name.trim().toLowerCase()}`;
    case 'niche': return `niche:${source.id.trim().toLowerCase()}`;
  }
}

/**
 * `mergeSig` (see mergeSignature) is appended only when some searched tag is merged; `src` (see
 * sourceKey) only for creator and niche streams.
 */
export function fillerId(queryKeyText: string, type: string, pageSize: number, ruleKeys: string[], mergeSig = '', src = ''): string {
  let id = `${queryKeyText}|${type}|${pageSize}|bl:${[...ruleKeys].sort().join(',')}`;
  if (mergeSig) id += `|mg:${mergeSig}`;
  if (src) id += `|src:${src}`;
  return id;
}

/** The merge groups that affect a query (members of every required / any / exact-excluded key). */
export function mergeSignature(query: Query, index: MergeIndex): string {
  const keys = new Set([...query.required, ...query.any, ...query.exclusions.filter((e) => e.mode === 'exact').map((e) => e.value)]);
  const groups = new Set<string>();
  for (const key of keys) {
    const members = index.members(key);
    if (members.length > 1) groups.add(members.join('+'));
  }
  return [...groups].sort().join(';');
}

/** "Searching big_tits (with big_boobs) for big_boobs." for each merged tag; null when none. */
export function mergeNote(applied: { from: string; to: string }[], index: MergeIndex): string | null {
  const byTo = new Map<string, string[]>();
  for (const { from, to } of applied) byTo.set(to, [...(byTo.get(to) ?? []), from]);
  const sentences = [...byTo].map(([to, froms]) => {
    const others = index.members(to).filter((m) => m !== to);
    const withText = others.length ? ` (with ${others.map(toTagTerm).join(', ')})` : '';
    return `Searching ${toTagTerm(to)}${withText} for ${froms.map(toTagTerm).join(', ')}.`;
  });
  return sentences.length ? sentences.join(' ') : null;
}

export interface TagRow {
  key: string;
  /** What users type and the sidebar shows, e.g. "big_tits". */
  term: string;
  /** RedGifs' casing from the posts, e.g. "Big Tits" (used for search requests). */
  name: string;
  /** Number of shown posts having the tag. */
  pageCount: number;
}

const byTerm = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Tags of the shown posts: by number of posts having it, then term; first seen casing as the name.
 * With a merge index, members of a group count as their canonical key (once per post), and the
 * name is the canonical tag's own casing (or its key when no post has the canonical tag itself).
 */
export function aggregateTags(gifs: Gif[], limit = 30, index?: MergeIndex): TagRow[] {
  const map = new Map<string, TagRow>();
  const ownName = new Set<string>(); // rows whose name comes from the canonical tag itself
  for (const gif of gifs) {
    const seen = new Set<string>();
    for (const raw of gif.tags ?? []) {
      const rawKey = normalizeTag(raw);
      const key = index ? index.canonical(rawKey) : rawKey;
      if (!key) continue;
      const own = key === rawKey;
      const row = map.get(key);
      if (row && own && !ownName.has(key)) {
        row.name = String(raw).trim();
        ownName.add(key);
      }
      if (seen.has(key)) continue;
      seen.add(key);
      if (row) row.pageCount++;
      else {
        map.set(key, { key, term: toTagTerm(key), name: own ? String(raw).trim() : key, pageCount: 1 });
        if (own) ownName.add(key);
      }
    }
  }
  return [...map.values()]
    .sort((a, b) => b.pageCount - a.pageCount || byTerm(a.term, b.term))
    .slice(0, limit);
}

/** RedGifs caps every search total at this many posts. */
export const SEARCH_TOTAL_CAP = 10000;

/** Request names of every member of a group (the tag's own name for its own key). */
export function groupNames(key: string, name: string, index: MergeIndex, canonical: (key: string) => string): string[] {
  return index.members(key).map((m) => (m === key ? name : canonical(m)));
}

/**
 * Global count of a tag group: the sum over its members. undefined while any member is still
 * loading; null when RedGifs has none of the members; members without a tag count as zero.
 */
export function groupGlobalCount(
  key: string,
  index: MergeIndex,
  globalCount: (key: string) => number | null | undefined,
): number | null | undefined {
  const values = index.members(key).map((m) => globalCount(m));
  if (values.some((v) => v === undefined)) return undefined;
  const known = values.filter((v): v is number => typeof v === 'number');
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

/** Fraction of scanned posts that matched the search: kept / (kept + rejected); undefined when nothing scanned. */
export function matchRate(state: Pick<FillState, 'posts' | 'rejected'>): number | undefined {
  const rejected = Object.values(state.rejected).reduce((a, b) => a + b, 0);
  const scanned = state.posts.length + rejected;
  return scanned > 0 ? state.posts.length / scanned : undefined;
}

export interface BaseInput {
  required: string[];
  index: MergeIndex;
  globalCount: (key: string) => number | null | undefined;
  /** RedGifs' search total of each stream's server page 1 (undefined = not fetched yet). */
  streamTotals: (number | undefined)[];
  /** See matchRate. */
  rate: number | undefined;
  /** The page has finished filling (fill phase 'done' or 'paused'): unknown totals will not arrive. */
  settled: boolean;
}

/**
 * True when the estimate of the search size needs the required groups' global counts: one required
 * group, a stream hit the cap, or a stream total is still unknown after the page finished filling.
 */
export function needsGroupCounts(required: string[], streamTotals: (number | undefined)[], settled: boolean): boolean {
  if (required.length === 0) return false;
  if (required.length === 1) return true;
  if (streamTotals.some((t) => t !== undefined && t >= SEARCH_TOTAL_CAP)) return true;
  return settled && streamTotals.some((t) => t === undefined);
}

/**
 * Estimated number of posts in the whole search (undefined = not known yet).
 * One required group: its global count. Otherwise the streams' totals times the exact-match rate,
 * or, when a stream hit RedGifs' 10000 cap, or a total is unknown after the page finished filling,
 * the smallest required group (an upper bound). While still filling with unknown totals: undefined.
 */
export function estimateSearchSize(input: BaseInput): number | undefined {
  const { required, index, globalCount, streamTotals, rate, settled } = input;
  if (required.length === 0) return undefined;
  const minGroup = () => {
    const counts = required.map((k) => groupGlobalCount(k, index, globalCount));
    if (counts.some((c) => c === undefined)) return undefined;
    return Math.min(...counts.map((c) => c ?? 0));
  };
  if (required.length === 1) return minGroup();
  if (streamTotals.length === 0) return undefined;
  if (streamTotals.some((t) => t === undefined)) return settled ? minGroup() : undefined;
  const totals = streamTotals as number[];
  if (totals.some((t) => t >= SEARCH_TOTAL_CAP)) return minGroup();
  if (rate === undefined) return undefined;
  return Math.round(totals.reduce((a, b) => a + b, 0) * rate);
}

/** At most this many unknown tag counts are looked up per page (each lookup is an API request). */
export const MAX_COUNT_LOOKUPS_PER_PAGE = 8;

/**
 * Which rows to look up next: rows (already ordered by page frequency) whose count is unknown and
 * that are not in `already`, as many as still fit under `max` once `already` is counted.
 */
export function pickCountLookups<T extends { key: string }>(
  rows: readonly T[],
  isKnown: (key: string) => boolean,
  already: ReadonlySet<string>,
  max = MAX_COUNT_LOOKUPS_PER_PAGE,
): T[] {
  const picked: T[] = [];
  for (const row of rows) {
    if (already.size + picked.length >= max) break;
    if (already.has(row.key) || isKnown(row.key)) continue;
    picked.push(row);
  }
  return picked;
}

/** Top tags by posts on the page, plus every required tag (even when not in the top). */
export function sidebarCandidates(tags: TagRow[], required: string[], canonical: (key: string) => string, limit = 25): TagRow[] {
  const top = [...tags].sort((a, b) => b.pageCount - a.pageCount || byTerm(a.term, b.term)).slice(0, limit);
  const have = new Set(top.map((t) => t.key));
  for (const key of required) {
    if (have.has(key)) continue;
    have.add(key);
    const onPage = tags.find((t) => t.key === key);
    top.push(onPage ?? { key, term: toTagTerm(key), name: canonical(key), pageCount: 0 });
  }
  return top;
}

export interface SidebarRow {
  key: string;
  /** Underscore term, used to build links. */
  term: string;
  /** Name shown in the sidebar: the normalized key, with spaces. */
  label: string;
  count: number | undefined;
  /** The count is an estimate (a search is active). */
  estimated: boolean;
  /** Share of the search's posts having the tag (searches only). */
  percent: number | undefined;
  /** No query and RedGifs has no such tag. */
  missing: boolean;
  inQuery: boolean;
}

export interface RankInput {
  tags: TagRow[];
  required: string[];
  globalCount: (key: string) => number | null | undefined;
  canonical: (key: string) => string;
  index?: MergeIndex;
  /** Estimated size of the whole search (see estimateSearchSize); ignored without required tags. */
  base: number | undefined;
  /** Number of posts on the page the tag counts come from. */
  postsOnPage: number;
  limit?: number;
  /**
   * Creator / niche grids: the counts are estimates from `base` (the size of the scope) even without
   * required tags, instead of RedGifs' global counts.
   */
  scoped?: boolean;
}

/**
 * Sidebar rows, most to least common on the page (then by term). Without required tags the count
 * is the tag group's global count. With them it is an estimate: base * pageCount / postsOnPage
 * (required tags: base), so no row exceeds the search.
 */
export function rankSidebarTags(input: RankInput): SidebarRow[] {
  const { required, globalCount, canonical, base, postsOnPage } = input;
  const estimated = required.length > 0 || input.scoped === true;
  const index = input.index ?? IDENTITY_INDEX;
  const requiredSet = new Set(required);
  const candidates = sidebarCandidates(input.tags, required, canonical, input.limit ?? 25);
  const rows = candidates.map((tag): SidebarRow => {
    const inQuery = requiredSet.has(tag.key);
    const row: SidebarRow = {
      key: tag.key, term: tag.term, label: tag.key, count: undefined,
      estimated, percent: undefined, missing: false, inQuery,
    };
    if (!estimated) {
      const g = groupGlobalCount(tag.key, index, globalCount);
      if (g === null) row.missing = true;
      else row.count = g;
    } else if (inQuery) {
      row.count = base;
      row.percent = 100;
    } else if (postsOnPage > 0) {
      const share = Math.min(1, tag.pageCount / postsOnPage);
      row.percent = Math.round(share * 100);
      if (base !== undefined) row.count = Math.min(base, Math.round(base * share));
    }
    return row;
  });
  const pageCount = new Map(candidates.map((t) => [t.key, t.pageCount]));
  return rows.sort((a, b) => (pageCount.get(b.key) ?? 0) - (pageCount.get(a.key) ?? 0) || byTerm(a.term, b.term));
}

/** The alias the query text uses for a page sort, e.g. "order:views". */
export function pageSortAlias(query: Query, sort: PageSort): string {
  return formatQuery({ ...query, required: [], any: [], exclusions: [], meta: [], type: 'g', serverOrder: 'trending', pageSort: sort });
}

export function errorMessage(error: unknown): string {
  if (error instanceof RateLimitedError) {
    return 'RedGifs is rate-limiting requests right now. Open RedGifs, then try again in a couple of minutes.';
  }
  return error instanceof Error ? error.message : String(error);
}

const formatInt = (n: number) => n.toLocaleString('en-US');

/** The line above the grid; null when nothing needs saying. */
export function progressText(state: FillState): string | null {
  const pages = `${state.serverPagesScanned} server page${state.serverPagesScanned === 1 ? '' : 's'}`;
  switch (state.phase) {
    case 'filling':
      return `Searching… ${state.posts.length} / ${state.pageSize} · ${pages} scanned`;
    case 'seeking':
      return `Finding where page ${state.page} starts… (filling page ${state.seekingPage ?? '?'})`;
    case 'paused': {
      const scanned = `Scanned ${pages} (≈${formatInt(state.serverPagesScanned * 100)} posts)`;
      if (state.posts.length === 0 && state.seekingPage === undefined && state.page > 1 && state.knownPages < state.page) {
        return `Still looking for where page ${state.page} starts. ${scanned} so far.`;
      }
      return `${scanned} and found ${state.posts.length} matches so far.`;
    }
    case 'error':
      return errorMessage(state.error);
    case 'done':
      if (state.posts.length === 0) {
        return state.page > 1 ? 'There are no more posts for this search.' : 'No posts matched your search.';
      }
      return null;
  }
}

/**
 * Size of a creator's / niche's search, for the sidebar estimates (undefined = not known yet).
 * `totals` are RedGifs' page-1 totals of the streams (creator: exact for the searched tags; niche:
 * the whole niche, as RedGifs cannot filter it). `filtered` = the search narrows the posts beyond
 * what RedGifs applied, so the totals are scaled by the exact-match rate.
 */
export function scopedBaseSize(totals: (number | undefined)[], filtered: boolean, rate: number | undefined): number | undefined {
  if (totals.length === 0 || totals.some((t) => t === undefined)) return undefined;
  const sum = (totals as number[]).reduce((a, b) => a + b, 0);
  if (!filtered) return sum;
  return rate === undefined ? undefined : Math.round(sum * rate);
}

/** Whether the query narrows a creator / niche stream (tags, exclusions, meta filters). */
export function hasFilters(query: Query): boolean {
  return query.required.length > 0 || query.any.length > 0 || query.exclusions.length > 0 || query.meta.length > 0;
}
