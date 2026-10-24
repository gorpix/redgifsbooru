import { useCallback, useEffect, useMemo } from 'preact/hooks';
import type { RedgifsApi, TagSuggestion } from '../api/client';
import type { TagCounts } from '../api/tagCounts';
import type { TagWiki } from '../api/types';
import { hrefFor, type Route, type Router } from '../router';
import { buildAliasMap } from '../search/aliases';
import { BUILTIN_ALIASES } from '../search/builtinAliases';
import { BUILTIN_CATEGORIES } from '../search/builtinCategories';
import { BUILTIN_MERGES } from '../search/builtinMerges';
import { CATEGORY_COLOR, CATEGORY_LABEL, CATEGORY_ORDER, categoryOf, isCategory, parseCategoryText } from '../search/categories';
import { buildMergeIndex, parseMergeText } from '../search/merges';
import { normalizeTag, toTagTerm } from '../search/tags';
import { getAliasText, parseAliasText, subscribeAliases } from '../store/aliases';
import { getCategoryText, setCategoryText, subscribeCategories } from '../store/categories';
import { getMergeText, subscribeMerges } from '../store/merges';
import { aliasesPointingTo, hasCategoryOverride, PICKABLE_CATEGORIES, postsWithTag, setCategoryOverride } from './browseHelpers';
import { Columns } from './Columns';
import { formatCount } from './format';
import { useSubscription } from './hooks';
import { errorMessage, groupGlobalCount } from './postsHelpers';
import { SearchBox } from './SearchBox';
import { Thumb } from './Thumb';
import { useLoad } from './useLoad';

const SITE = 'RedGIFsbooru';

interface Props {
  api: RedgifsApi;
  router: Router;
  tagCounts: TagCounts;
}

/** Search box of the wiki pages: submitting opens the wiki page of the typed tag. */
function WikiSearch({ api, router, tagCounts, initial }: Props & { initial: string }) {
  return (
    <SearchBox
      key={initial}
      api={api}
      router={router}
      tagCounts={tagCounts}
      initial={initial}
      placeholder="Tag"
      submitHref={(text) => {
        const tag = normalizeTag(text.split(/[\s,]+/)[0] ?? '');
        return tag ? hrefFor({ name: 'wiki', tag }) : hrefFor({ name: 'wikiIndex', q: '' });
      }}
    />
  );
}

// ------------------------------------------------------------------ wiki index

export function WikiIndex({ api, router, tagCounts, route }: Props & { route: Extract<Route, { name: 'wikiIndex' }> }) {
  const q = route.q;
  const matches = useLoad<TagSuggestion[]>(`suggest:${q}`, () => (q ? api.suggestTags(q) : Promise.resolve([])));
  useEffect(() => { document.title = `Tag wiki | ${SITE}`; }, []);

  const byCategory = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const [key, category] of Object.entries(BUILTIN_CATEGORIES)) {
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category)!.push(key);
    }
    for (const list of groups.values()) list.sort();
    return groups;
  }, []);

  return (
    <Columns api={api} router={router} tagCounts={tagCounts} route={route} searchTitle="Search tags" searchBox={<WikiSearch api={api} router={router} tagCounts={tagCounts} initial={q} />}>
      <h1 class="rgb-title">Tag wiki</h1>
      <p>Type a tag in the search box to open its wiki page.</p>
      {q && (
        <section class="rgb-wiki-section">
          <h2 class="rgb-section">Tags matching {toTagTerm(q)}</h2>
          {matches.status === 'loading' && <p class="rgb-progress">Searching…</p>}
          {matches.status === 'error' && <p class="error">{errorMessage(matches.error)}</p>}
          {matches.status === 'ok' && matches.value.length === 0 && <p class="muted">No tags found.</p>}
          {matches.status === 'ok' && matches.value.length > 0 && (
            <ul class="rgb-wiki-list">
              {matches.value.map((m) => (
                <li key={m.text}>
                  <a href={hrefFor({ name: 'wiki', tag: normalizeTag(m.text) })}>{normalizeTag(m.text)}</a>
                  <span class="count">{formatCount(m.count)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <section class="rgb-wiki-section">
        <h2 class="rgb-section">Common tags</h2>
        {[...CATEGORY_ORDER].filter((c) => byCategory.has(c)).map((category) => (
          <details key={category} class="rgb-wiki-group">
            <summary style={{ color: CATEGORY_COLOR[category] }}>{CATEGORY_LABEL[category]} ({byCategory.get(category)!.length})</summary>
            <ul class="rgb-wiki-list">
              {byCategory.get(category)!.map((key) => (
                <li key={key}><a href={hrefFor({ name: 'wiki', tag: key })} style={{ color: CATEGORY_COLOR[category] }}>{key}</a></li>
              ))}
            </ul>
          </details>
        ))}
      </section>
    </Columns>
  );
}

// ------------------------------------------------------------------ wiki page

interface Known {
  name: string;
  wiki: TagWiki | null;
}
type Lookup = { kind: 'known'; known: Known } | { kind: 'unknown'; suggestions: TagSuggestion[] };

export function WikiPage({ api, router, tagCounts, route }: Props & { route: Extract<Route, { name: 'wiki' }> }) {
  const key = route.tag;

  const aliasVersion = useSubscription(subscribeAliases);
  const aliasMap = useMemo(() => buildAliasMap(BUILTIN_ALIASES, parseAliasText(getAliasText())), [aliasVersion]);
  const mergeVersion = useSubscription(subscribeMerges);
  const mergeIndex = useMemo(() => buildMergeIndex(BUILTIN_MERGES, parseMergeText(getMergeText())), [mergeVersion]);
  const categoryVersion = useSubscription(subscribeCategories);
  const categoryText = useMemo(() => getCategoryText(), [categoryVersion]);
  const subscribeCounts = useCallback((listener: () => void) => tagCounts.subscribe(listener), [tagCounts]);
  useSubscription(subscribeCounts);

  // matchTag (1 day cache) -> RedGifs' spelling, then the wiki entry (1 day cache); unknown tags get suggestions.
  const lookup = useLoad<Lookup>(`wiki:${key}`, async (signal) => {
    const name = await api.matchTag(key);
    if (name === null) {
      const suggestions = await api.suggestTags(key).catch(() => [] as TagSuggestion[]);
      return { kind: 'unknown', suggestions };
    }
    const wiki = await api.tagWiki(name, { signal });
    return { kind: 'known', known: { name, wiki } };
  });
  const known = lookup.status === 'ok' && lookup.value.kind === 'known' ? lookup.value.known : null;

  // The strip of posts: one search request (24 results, newest trending), kept to posts carrying the tag.
  const strip = useLoad(known ? `strip:${key}` : '', async (signal) => {
    if (!known) return [];
    const page = await api.searchGifs({ tags: [known.name], count: 24, order: 'trending' }, { signal });
    return postsWithTag(page.gifs, key, 12);
  });

  const members = mergeIndex.members(key);
  useEffect(() => {
    if (!known) return;
    // Global counts come through the shared TagCounts (low priority, cached 3 days).
    tagCounts.request(members.map((m) => (m === key ? known.name : m)));
  }, [known, tagCounts, members.join('|')]);

  useEffect(() => {
    document.title = `${key} – wiki | ${SITE}`;
  }, [key]);

  const userCategories = useMemo(() => parseCategoryText(categoryText), [categoryText]);
  const category = categoryOf(key, BUILTIN_CATEGORIES, userCategories, mergeIndex);
  const overridden = hasCategoryOverride(categoryText, key);
  const color = CATEGORY_COLOR[category];
  const count = groupGlobalCount(key, mergeIndex, (m) => tagCounts.get(m));
  const aliases = aliasesPointingTo(aliasMap, key);
  const others = members.filter((m) => m !== key);
  const wikiLink = (tag: string) => hrefFor({ name: 'wiki', tag: normalizeTag(tag) });

  const onCategory = (event: Event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (isCategory(value)) setCategoryText(setCategoryOverride(getCategoryText(), key, value));
  };

  return (
    <Columns api={api} router={router} tagCounts={tagCounts} route={route} searchTitle="Search tags" searchBox={<WikiSearch api={api} router={router} tagCounts={tagCounts} initial="" />}>
      <h1 class="rgb-title" style={{ color }}>{key}</h1>
      {lookup.status === 'loading' && <p class="rgb-progress">Loading…</p>}
      {lookup.status === 'error' && (
        <div class="rgb-notice error">
          <p>{errorMessage(lookup.error)}</p>
          <button type="button" onClick={lookup.retry}>Retry</button>
        </div>
      )}
      {lookup.status === 'ok' && lookup.value.kind === 'unknown' && (
        <div class="rgb-notice">
          <p>
            No tag named {toTagTerm(key)}.
            {(() => {
              const options = lookup.value.suggestions.filter((s) => normalizeTag(s.text) !== key).slice(0, 4);
              return options.length > 0 && (
                <>
                  {' Did you mean: '}
                  {options.map((s, i) => (
                    <span key={s.text}>{i > 0 && ', '}<a href={wikiLink(s.text)}>{normalizeTag(s.text)}</a></span>
                  ))}
                  ?
                </>
              );
            })()}
          </p>
        </div>
      )}
      {known && (
        <>
          <table class="rgb-info rgb-wiki-info">
            <tbody>
              <tr>
                <th>Posts</th>
                <td>{count === undefined ? '…' : count === null ? '–' : `${count.toLocaleString('en-US')}`}</td>
              </tr>
              <tr>
                <th>Category</th>
                <td>
                  <select value={category} onChange={onCategory} aria-label="Category of this tag">
                    {PICKABLE_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
                  </select>
                  {overridden && (
                    <> <button type="button" class="link-btn" title="Use the built-in category again" onClick={() => setCategoryText(setCategoryOverride(getCategoryText(), key, null))}>reset</button></>
                  )}
                </td>
              </tr>
              {aliases.length > 0 && (
                <tr>
                  <th>Aliases</th>
                  <td>{aliases.map((a, i) => <span key={a}>{i > 0 && ', '}{a}</span>)}</td>
                </tr>
              )}
              {others.length > 0 && (
                <tr>
                  <th>Merged with</th>
                  <td>
                    {others.map((m, i) => (
                      <span key={m}>{i > 0 && ', '}<a href={wikiLink(m)}>{m}</a>{m === mergeIndex.canonical(key) ? ' (main tag)' : ''}</span>
                    ))}
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <p class="rgb-wiki-desc">
            {known.wiki?.description ?? <span class="muted">No description on RedGifs.</span>}
          </p>

          {known.wiki && known.wiki.related.length > 0 && (
            <section class="rgb-wiki-section">
              <h2 class="rgb-section">Related tags</h2>
              <ul class="rgb-wiki-list">
                {known.wiki.related.map((name) => {
                  const n = tagCounts.get(name);
                  return (
                    <li key={name}>
                      <a href={wikiLink(name)}>{normalizeTag(name)}</a>
                      {typeof n === 'number' && <span class="count">{formatCount(n)}</span>}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <section class="rgb-wiki-section">
            <h2 class="rgb-section">Posts</h2>
            {strip.status === 'loading' && <p class="rgb-progress">Loading posts…</p>}
            {strip.status === 'error' && <p class="error">{errorMessage(strip.error)} <button type="button" onClick={strip.retry}>Retry</button></p>}
            {strip.status === 'ok' && strip.value.length === 0 && <p class="muted">No recent posts carry this tag.</p>}
            {strip.status === 'ok' && strip.value.length > 0 && (
              <div class="thumb-grid">
                {strip.value.map((gif) => <Thumb key={gif.id} gif={gif} q={toTagTerm(key)} />)}
              </div>
            )}
            <p><a href={hrefFor({ name: 'posts', tags: toTagTerm(key), page: 1 })}>View all posts</a></p>
          </section>
        </>
      )}
    </Columns>
  );
}
