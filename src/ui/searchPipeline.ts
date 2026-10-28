// Everything derived from a search string, shared by the posts grid and the post page so both
// use the exact same PageFiller (and therefore the same remembered pages) for a given search.
//
//   tags string -> parse -> aliases -> merges  = query (+ notes about what was applied)
//   query + blacklist + settings                = active rules, filler id
//   tag validation (api.matchTag)               = canonical spellings, needed to build requests
//   id + canonical spellings                    = FillerEntry (getFiller), fetchers, checks
//
// PostPage: call `useSearchPipeline(route.q, { api })`. Once `pipeline.entry` is non-null (it is
// null until tag validation succeeded; with an empty search that is immediate) it is the same
// FillerEntry object PostsIndex got for the same search, because the entry is looked up by
// `pipeline.id` in the shared getFiller cache. Use `runFill(pipeline.entry, page, onUpdate, signal)`
// to read page +/- 1 (cached pages resolve quickly) and `pagePosts(pipeline.id, page)` for pages
// PostsIndex already remembered. matchTag answers are cached for a day, so validation is normally
// free when arriving from the grid.
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { RedgifsApi, TagSuggestion } from '../api/client';
import { createMergedFeed } from '../search/mergedFeed';
import { fetchNichePage } from '../api/nicheOrder';
import type { SearchOrder, SearchPage } from '../api/types';
import { aliasBlacklist, applyAliases, buildAliasMap } from '../search/aliases';
import { BUILTIN_ALIASES } from '../search/builtinAliases';
import { BUILTIN_MERGES } from '../search/builtinMerges';
import { PageFiller, type FetchStreamPage } from '../search/filler';
import { checkGif, parseBlacklist, type BlacklistRule } from '../search/match';
import { applyMerges, buildMergeIndex, mergeBlacklist, parseMergeText, type MergeIndex } from '../search/merges';
import { formatQuery, parseQuery, queryKey, type Query } from '../search/query';
import { serverStreams } from '../search/server';
import { combineStreams } from '../search/streams';
import { getAliasText, parseAliasText, subscribeAliases } from '../store/aliases';
import { getBlacklistText, getPausedKeys, subscribeBlacklist } from '../store/blacklist';
import { getMergeText, subscribeMerges } from '../store/merges';
import { defaultStorage } from '../store/storage';
import { getSettings, subscribeSettings, type Settings } from '../store/settings';
import { getFiller, type FillerEntry } from './fillers';
import { useFollowedNames } from './account';
import { useSubscription } from './hooks';
import { djb2Hex, effectiveSource, fillerId, mergeSignature, SEARCH_SOURCE, sourceKey, type Source } from './postsHelpers';

export type { Source } from './postsHelpers';

/** Server pages (100 posts each) scanned per run before pausing, so one search costs at most ~10 requests. */
export const MAX_SERVER_PAGES_PER_RUN = 10;

type AliasMap = ReadonlyMap<string, string>;

/**
 * RedGifs' search total of each stream's server page 1, by filler id. Module level so it survives
 * remounts together with the cached fillers. Used for the sidebar's estimates.
 */
const searchTotals = new Map<string, (number | undefined)[]>();

/** The recorded totals for a filler id, or one `undefined` per server stream when none yet. */
export function streamTotalsFor(id: string, query: Query, index: MergeIndex): (number | undefined)[] {
  return searchTotals.get(id) ?? serverStreams(query, index, (k) => k).map(() => undefined);
}

function session(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- pure parts

export interface DerivedQuery {
  aliased: ReturnType<typeof applyAliases>;
  merged: ReturnType<typeof applyMerges>;
  /** The final query: parsed, aliased, merged. */
  query: Query;
  queryText: string;
}

/** parse -> aliases -> merges. `forceFav` (a favorites grid) makes it a `fav:me` query whatever the text says. */
export function deriveQuery(tagsText: string, aliasMap: AliasMap, mergeIndex: MergeIndex, forceFav = false): DerivedQuery {
  const aliased = applyAliases(parseQuery(tagsText), aliasMap);
  const merged = applyMerges(aliased.query, mergeIndex);
  const query = forceFav && !merged.query.fav ? { ...merged.query, fav: true } : merged.query;
  return { aliased, merged, query, queryText: formatQuery(query) };
}

/**
 * RedGifs' page count as the filler wants it: a feed that does not say (0) is read until it
 * returns an empty page (Infinity is "not a finite number", which the filler ignores).
 */
export function streamPages(pages: number, gifCount: number): number {
  return pages > 0 || gifCount === 0 ? pages : Infinity;
}

/** The user's blacklist with aliases and merges applied (all rules, paused or not). */
export function deriveBlacklist(blacklistText: string, aliasMap: AliasMap, mergeIndex: MergeIndex): BlacklistRule[] {
  return mergeBlacklist(aliasBlacklist(parseBlacklist(blacklistText), aliasMap), mergeIndex);
}

/** The rules actually applied: none when the blacklist is off, otherwise without paused rules. */
export function activeRules(allRules: BlacklistRule[], enabled: boolean, pausedKeys: Iterable<string>): BlacklistRule[] {
  if (!enabled) return [];
  const paused = new Set(pausedKeys);
  return allRules.filter((r) => !paused.has(r.key));
}

/** Tags a search needs to exist on RedGifs: every required and ~any key. */
export function validationKeys(query: Query): string[] {
  return [...new Set([...query.required, ...query.any])];
}

/** Key of the shared PageFiller for this search. */
export function pipelineFillerId(query: Query, pageSize: number, rules: BlacklistRule[], mergeIndex: MergeIndex, source: Source = SEARCH_SOURCE): string {
  return fillerId(queryKey(query), query.type, pageSize, rules.map((r) => r.key), mergeSignature(query, mergeIndex), sourceKey(source));
}

/**
 * The server order to ask a creator's posts for: their default is newest first, so the search
 * default ('trending', what an unmarked query parses to) means 'latest' there.
 */
export function userStreamOrder(order: SearchOrder): SearchOrder {
  return order === 'trending' ? 'latest' : order;
}

export interface EntryInput {
  api: RedgifsApi;
  id: string;
  query: Query;
  rules: BlacklistRule[];
  mergeIndex: MergeIndex;
  pageSize: number;
  /** key -> RedGifs' spelling (from tag validation); keys missing here are sent as typed. */
  canonical?: Map<string, string>;
  /** Where the posts come from (default: the global search). */
  source?: Source;
}

/** The shared FillerEntry for `id`, creating it (stream fetchers, combineStreams, checks) the first time. */
export function buildFillerEntry({ api, id, query, rules, mergeIndex, pageSize, canonical, source = SEARCH_SOURCE }: EntryInput): FillerEntry {
  const spelled = (key: string) => canonical?.get(key) ?? key;
  const { serverOrder: order, type } = query;
  // A niche, my favorites and a set cannot be filtered by tag on the server: one stream, every
  // filter applies client-side.
  const streamTags = source.kind === 'niche' || source.kind === 'liked' || source.kind === 'set'
    ? [undefined]
    : serverStreams(query, mergeIndex, spelled);
  const load = (tags: string[] | undefined, serverPage: number, signal: AbortSignal): Promise<SearchPage> => {
    switch (source.kind) {
      case 'user':
        return api.userGifs(source.name, { tags, order: userStreamOrder(order), type, count: 100, page: serverPage }, { signal });
      case 'niche':
        // 'trending' (the default) is probed once and remembered; see fetchNichePage.
        return fetchNichePage(api, source.id, { order, count: 100, page: serverPage }, { signal }, defaultStorage());
      case 'liked':
        return api.account.likedFeed({ page: serverPage, count: 30, type }, { signal });
      case 'set':
        // A set holds videos and images alike, so the type: filter does not apply.
        return api.account.collectionGifs(source.id, { page: serverPage, count: 100 }, { signal });
      case 'following':
        throw new Error('the feed reads creators through its merged streams');
      case 'search':
        return api.searchGifs({ order, type, tags, count: 100, page: serverPage }, { signal });
    }
  };
  // The feed: per tag stream, a merge of every followed creator's newest-first posts (30 per request).
  const feeds: FetchStreamPage[] | null = source.kind === 'following'
    ? streamTags.map((tags) => createMergedFeed((source.names ?? []).map((name) => (page, signal) =>
      api.userGifs(name, { order: 'latest', type, tags, count: 30, page }, { signal }))))
    : null;
  const fetchers: FetchStreamPage[] = feeds ?? streamTags.map((tags, streamIndex) => (serverPage, signal) =>
    load(tags, serverPage, signal)
      .then((r) => {
        if (serverPage === 1) {
          const totals = searchTotals.get(id) ?? streamTags.map(() => undefined);
          totals[streamIndex] = r.total;
          searchTotals.set(id, totals);
        }
        return { gifs: r.gifs, pages: source.kind === 'liked' || source.kind === 'set' ? streamPages(r.pages, r.gifs.length) : r.pages };
      }));
  const now = () => Date.now() / 1000;
  return getFiller(id, () => new PageFiller({
    key: djb2Hex(id),
    pageSize,
    maxServerPagesPerRun: MAX_SERVER_PAGES_PER_RUN,
    storage: session(),
    fetchPage: combineStreams(fetchers, source.kind === 'following' ? 'latest' : order),
    check: (gif) => checkGif(gif, query, rules, now(), mergeIndex),
  }));
}

// ---------------------------------------------------------------- tag validation

export type Validation =
  | { id: string; kind: 'ok'; canonical: Map<string, string> }
  | { id: string; kind: 'unknown'; unknown: { key: string; suggestions: TagSuggestion[] }[] }
  | { id: string; kind: 'error'; error: unknown };

const EMPTY_CANONICAL = new Map<string, string>();

// ---------------------------------------------------------------- the hook

export interface SearchPipeline extends DerivedQuery {
  aliasMap: AliasMap;
  mergeIndex: MergeIndex;
  settings: Settings;
  pageSize: number;
  /** All blacklist rules (aliased + merged), including paused ones and when the blacklist is off. */
  allRules: BlacklistRule[];
  /** The rules in effect for the search. */
  rules: BlacklistRule[];
  /** The source the grid really reads (a `fav:me` search reads my favorites). */
  source: Source;
  /** Filler id: identifies the shared PageFiller. */
  id: string;
  /** null while tags are being checked; 'ok' once every required / ~any tag exists on RedGifs. */
  validation: Validation | null;
  ready: boolean;
  /** key -> RedGifs spelling; an empty map until validation is ok. */
  canonical: Map<string, string>;
  /** Shared filler entry; null until `ready`. */
  entry: FillerEntry | null;
  /** Re-runs a failed validation. */
  retryValidation(): void;
  /** RedGifs' page-1 totals of each server stream recorded so far (undefined entries when unknown). */
  streamTotals(): (number | undefined)[];
}

/**
 * Derives the whole search pipeline for a tags string (see the file header). Behaviour is exactly
 * what PostsIndex did inline: it re-derives when aliases / merges / blacklist / settings change.
 */
export function useSearchPipeline(
  tagsText: string,
  { api, source: given = SEARCH_SOURCE, enabled = true }: { api: RedgifsApi; source?: Source; /** false = build no filler (e.g. a favorites grid while logged out). */ enabled?: boolean },
): SearchPipeline {
  const aliasVersion = useSubscription(subscribeAliases);
  const aliasMap = useMemo(
    () => buildAliasMap(BUILTIN_ALIASES, parseAliasText(getAliasText())),
    [aliasVersion],
  );
  const mergeVersion = useSubscription(subscribeMerges);
  const mergeIndex = useMemo(
    () => buildMergeIndex(BUILTIN_MERGES, parseMergeText(getMergeText())),
    [mergeVersion],
  );
  const derived = useMemo(() => deriveQuery(tagsText, aliasMap, mergeIndex, given.kind === 'liked'), [tagsText, aliasMap, mergeIndex, given.kind]);
  const { query } = derived;
  // The feed needs the followed names (they are part of the filler id, so following / unfollowing rebuilds it).
  const followed = useFollowedNames(given.kind === 'following');
  const effective = effectiveSource(query, given);
  const source: Source = effective.kind === 'following' ? { kind: 'following', names: followed.names } : effective;
  const followedReady = effective.kind !== 'following' || (followed.state === 'ready' && followed.names.length > 0);

  const settingsVersion = useSubscription(subscribeSettings);
  const blacklistVersion = useSubscription(subscribeBlacklist);
  const settings = useMemo(() => getSettings(), [settingsVersion]);
  const allRules = useMemo(
    () => deriveBlacklist(getBlacklistText(), aliasMap, mergeIndex),
    [blacklistVersion, aliasMap, mergeIndex],
  );
  const rules = useMemo(
    () => activeRules(allRules, settings.blacklistEnabled, getPausedKeys()),
    [allRules, settings.blacklistEnabled, blacklistVersion],
  );
  const pageSize = settings.postsPerPage;

  // Tag validation (every required / ~any tag must exist on RedGifs).
  const keys = useMemo(() => validationKeys(query), [query]);
  const keysId = keys.join('\n');
  const [validated, setValidated] = useState<Validation | null>(null);
  const [retryTags, setRetryTags] = useState(0);

  useEffect(() => {
    if (keys.length === 0) return;
    let cancelled = false;
    Promise.all(keys.map((key) => api.matchTag(key))).then(async (names) => {
      const canonical = new Map<string, string>();
      const missing: string[] = [];
      names.forEach((name, i) => {
        if (name === null) missing.push(keys[i]);
        else canonical.set(keys[i], name);
      });
      if (missing.length === 0) {
        if (!cancelled) setValidated({ id: keysId, kind: 'ok', canonical });
        return;
      }
      const unknown = await Promise.all(missing.map(async (key) => ({
        key,
        suggestions: await api.suggestTags(key).catch(() => [] as TagSuggestion[]),
      })));
      if (!cancelled) setValidated({ id: keysId, kind: 'unknown', unknown });
    }, (error) => {
      if (!cancelled) setValidated({ id: keysId, kind: 'error', error });
    });
    return () => { cancelled = true; };
  }, [api, keysId, retryTags]);

  const validation: Validation | null = keys.length === 0
    ? { id: '', kind: 'ok', canonical: new Map() }
    : validated && validated.id === keysId ? validated : null;
  const ready = validation?.kind === 'ok' && enabled && followedReady;

  const id = pipelineFillerId(query, pageSize, rules, mergeIndex, source);
  const entry = useMemo(() => {
    if (!ready) return null;
    const canonical = validation?.kind === 'ok' ? validation.canonical : undefined;
    return buildFillerEntry({ api, id, query, rules, mergeIndex, pageSize, canonical, source });
  }, [ready, id, api]);

  return {
    ...derived,
    aliasMap,
    mergeIndex,
    settings,
    pageSize,
    allRules,
    rules,
    source,
    id,
    validation,
    ready,
    canonical: validation?.kind === 'ok' ? validation.canonical : EMPTY_CANONICAL,
    entry,
    retryValidation: () => { setValidated(null); setRetryTags((n) => n + 1); },
    streamTotals: () => streamTotalsFor(id, query, mergeIndex),
  };
}
