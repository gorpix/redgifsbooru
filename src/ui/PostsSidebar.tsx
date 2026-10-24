import { useCallback, useEffect, useMemo, useRef } from 'preact/hooks';
import type { TagCounts } from '../api/tagCounts';
import type { Gif } from '../api/types';
import { hrefFor } from '../router';
import { addTagToQuery, excludeTagFromQuery } from '../search/edit';
import type { BlacklistRule } from '../search/match';
import type { MergeIndex } from '../search/merges';
import { formatQuery, type Query } from '../search/query';
import { getPausedKeys, setPausedKeys, subscribeBlacklist } from '../store/blacklist';
import { getSavedSearches, removeSavedSearch, saveSearch, subscribeSaved } from '../store/saved';
import { updateSettings } from '../store/settings';
import { formatCount } from './format';
import { useSubscription } from './hooks';
import { aggregateTags, estimateSearchSize, groupGlobalCount, groupNames, needsGroupCounts, pickCountLookups, rankSidebarTags, sidebarCandidates } from './postsHelpers';

const search = (tags: string) => hrefFor({ name: 'posts', tags, page: 1 });
const wiki = (key: string) => hrefFor({ name: 'wiki', tag: key });

export function SavedSearches({ query }: { query: Query }) {
  const version = useSubscription(subscribeSaved);
  const saved = useMemo(() => getSavedSearches(), [version]);
  const current = formatQuery(query);
  return (
    <section>
      <h2>Saved searches</h2>
      {saved.length === 0 && <p class="muted">None yet.</p>}
      {saved.length > 0 && (
        <ul class="rgb-list">
          {saved.map((s) => (
            <li key={s.query}>
              <a href={search(s.query)} title={s.query}>{s.name}</a>
              <button type="button" class="link-btn" title="Remove" aria-label={`Remove ${s.name}`} onClick={() => removeSavedSearch(s.query)}>×</button>
            </li>
          ))}
        </ul>
      )}
      {current && !saved.some((s) => s.query === current) && (
        <button type="button" onClick={() => saveSearch(current, current)}>Save this search</button>
      )}
    </section>
  );
}

interface TagListProps {
  posts: Gif[];
  query: Query;
  queryText: string;
  tagCounts: TagCounts;
  /** RedGifs spelling of the query's tags (from tag validation). */
  canonical: Map<string, string>;
  /** Merge groups: tags are shown as their canonical key and counts add up over the members. */
  index: MergeIndex;
  /** RedGifs' search total per stream (server page 1); undefined = not fetched yet. */
  streamTotals: (number | undefined)[];
  /** Share of scanned posts that matched the search exactly; undefined = nothing scanned yet. */
  rate: number | undefined;
  /** The page has finished filling (fill phase 'done' or 'paused'). */
  settled: boolean;
  /** Link of a search on this grid; default: the posts index. Creator and pool pages scope it. */
  searchHref?: (tags: string) => string;
  /**
   * Creator / niche grids: counts are estimates from `size` (the scope's size, see scopedBaseSize),
   * and no global-count lookups are made. Omit for the posts index.
   */
  scope?: { size: number | undefined };
}

export function TagList({ posts, query, queryText, tagCounts, canonical, index, streamTotals, rate, settled, searchHref = search, scope }: TagListProps) {
  const required = query.required;
  const canonicalOf = useCallback((key: string) => canonical.get(key) ?? key, [canonical]);
  const tags = useMemo(() => aggregateTags(posts, 1000, index), [posts, index]);
  const subscribeTags = useCallback((listener: () => void) => tagCounts.subscribe(listener), [tagCounts]);
  useSubscription(subscribeTags);

  const candidates = useMemo(() => sidebarCandidates(tags, required, canonicalOf), [tags, required, canonicalOf]);
  const needGroups = !scope && needsGroupCounts(required, streamTotals, settled);
  // Without a query: the candidates' groups. With one: only the required groups, and only when the estimate needs them.
  // Without a query, only the first few unknown tags per page are looked up (each is an API request);
  // the choice is remembered so counts arriving do not pull in more lookups.
  const chosen = useRef<{ scope: string; keys: Set<string> }>({ scope: queryText, keys: new Set() });
  if (chosen.current.scope !== queryText || posts.length === 0) chosen.current = { scope: queryText, keys: new Set() };
  if (!required.length && !scope) {
    const picks = pickCountLookups(candidates, (key) => groupGlobalCount(key, index, (m) => tagCounts.get(m)) !== undefined, chosen.current.keys);
    for (const pick of picks) chosen.current.keys.add(pick.key);
  }
  const lookups = scope ? [] : !required.length
    ? candidates.filter((r) => chosen.current.keys.has(r.key)).map((r) => ({ key: r.key, name: r.name }))
    : needGroups ? required.map((key) => ({ key, name: canonicalOf(key) })) : [];
  const wanted = lookups.map((r) => `${index.members(r.key).join('+')}:${r.name}`).join(',');
  useEffect(() => {
    if (lookups.length) tagCounts.request(lookups.flatMap((r) => groupNames(r.key, r.name, index, canonicalOf)));
  }, [wanted, tagCounts, canonicalOf, index]);

  const globalCount = (key: string) => tagCounts.get(key);
  const base = scope ? scope.size : required.length ? estimateSearchSize({ required, index, globalCount, streamTotals, rate, settled }) : undefined;
  const rows = rankSidebarTags({ tags, required, globalCount, canonical: canonicalOf, index, base, postsOnPage: posts.length, scoped: !!scope });
  const pageCounts = new Map(tags.map((t) => [t.key, t.pageCount]));

  const inQuery = new Set([...query.required, ...query.any, ...query.exclusions.filter((e) => e.mode === 'exact').map((e) => e.value)]);
  return (
    <section>
      <h2>Tags</h2>
      {rows.length === 0 && <p class="muted">No posts yet.</p>}
      {rows.length > 0 && (
        <ul class="rgb-tags">
          {rows.map((row) => (
            <li key={row.key} class={inQuery.has(row.key) ? 'in-query' : ''}>
              <a class="wiki" href={wiki(row.key)} title="Tag wiki">?</a>
              <a class="op" href={searchHref(addTagToQuery(queryText, row.key))} title="Add to search">+</a>
              <a class="op" href={searchHref(excludeTagFromQuery(queryText, row.key))} title="Exclude from search">–</a>
              <a class="name" href={searchHref(row.term)} title={`Posts here with this tag: ${pageCounts.get(row.key) ?? 0}`}>{row.label}</a>
              <span
                class="count"
                title={row.estimated
                  ? `Estimated: about ${row.percent ?? '?'}% of this search's posts have this tag`
                  : 'Posts on RedGifs'}
              >
                {row.count === undefined
                  ? (row.missing ? '?' : (!required.length && !scope && !chosen.current.keys.has(row.key) ? '' : '…'))
                  : `${row.estimated ? '~' : ''}${formatCount(row.count)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function BlacklistPanel({ rules, enabled, hidden }: { rules: BlacklistRule[]; enabled: boolean; hidden: number | null }) {
  const version = useSubscription(subscribeBlacklist);
  const paused = useMemo(() => new Set(getPausedKeys()), [version]);
  const toggle = (key: string) => {
    const next = new Set(paused);
    if (!next.delete(key)) next.add(key);
    setPausedKeys([...next]);
  };
  return (
    <section>
      <h2>
        Blacklist
        {enabled && hidden !== null && hidden > 0 && <span class="muted"> ({hidden} hidden here)</span>}
      </h2>
      <p class="rgb-bl-actions">
        <button type="button" class="link-btn" onClick={() => updateSettings({ blacklistEnabled: !enabled })}>
          {enabled ? 'Disable all' : 'Enable all'}
        </button>
        {' · '}
        <a href={hrefFor({ name: 'settings' })}>Edit</a>
      </p>
      {rules.length === 0 && <p class="muted">No rules.</p>}
      {rules.length > 0 && (
        <ul class={enabled ? 'rgb-list rgb-rules' : 'rgb-list rgb-rules off'}>
          {rules.map((rule) => {
            const off = paused.has(rule.key);
            return (
              <li key={rule.key} class={off ? 'paused' : ''}>
                <button
                  type="button"
                  class="link-btn"
                  title={off ? 'Paused; click to apply again' : 'Click to pause this rule'}
                  onClick={() => toggle(rule.key)}
                >
                  {rule.mode === 'partial' ? '*' : ''}{rule.value.replace(/ /g, '_')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
