import { useEffect, useMemo } from 'preact/hooks';
import type { RedgifsApi } from '../api/client';
import type { TagCounts } from '../api/tagCounts';
import { hrefFor, type Route, type Router } from '../router';
import { parseQuery } from '../search/query';
import { useAuthState } from './account';
import { gateNotice } from './accountHelpers';
import { Columns } from './Columns';
import { PostGrid, usePostGrid } from './PostGrid';
import { BlacklistPanel, FiltersPanel, SavedSearches, TagList } from './PostsSidebar';
import { ScopedSidebar } from './ScopedSidebar';
import { matchRate } from './postsHelpers';
import { useSearchPipeline } from './searchPipeline';

const SITE = 'RedGIFsbooru';

interface Props {
  api: RedgifsApi;
  router: Router;
  tagCounts: TagCounts;
  route: Extract<Route, { name: 'posts' }>;
}

export function PostsIndex({ api, router, tagCounts, route }: Props) {
  // `fav:me` reads my favorites, which needs the RedGifs login (checked before anything is scanned).
  const wantsFav = useMemo(() => parseQuery(route.tags).fav, [route.tags]);
  const { gate } = useAuthState();
  const notice = wantsFav ? gateNotice(gate, 'favorites') : null;
  const pipeline = useSearchPipeline(route.tags, { api, enabled: !notice });
  const { query, queryText, mergeIndex, settings, allRules } = pipeline;
  const grid = usePostGrid(pipeline, route.page);
  const { state, posts } = grid;

  useEffect(() => {
    const base = queryText || 'Posts';
    document.title = `${base} | ${SITE}${route.page > 1 ? ` – page ${route.page}` : ''}`;
  }, [queryText, route.page]);

  const scopedHref = (tags: string) => hrefFor({ name: 'posts', tags, page: 1 });
  const sidebar = wantsFav ? (
    <ScopedSidebar grid={grid} tagCounts={tagCounts} searchHref={scopedHref} />
  ) : (
    <>
      <SavedSearches query={query} />
      <TagList posts={posts} query={query} queryText={queryText} tagCounts={tagCounts} canonical={pipeline.canonical} index={mergeIndex} streamTotals={pipeline.streamTotals()} rate={state ? matchRate(state) : undefined} settled={state?.phase === 'done' || state?.phase === 'paused'} />
      <FiltersPanel rejected={state ? state.rejected : null} />
      <BlacklistPanel rules={allRules} enabled={settings.blacklistEnabled} hidden={state ? (state.rejected.blacklist ?? 0) : null} />
    </>
  );

  return (
    <Columns api={api} router={router} tagCounts={tagCounts} route={route} sidebar={sidebar}>
      <h1 class="rgb-title">{queryText ? `Posts: ${queryText}` : 'Posts'}</h1>
      {notice
        ? <div class="rgb-notice"><p>{notice}</p></div>
        : <PostGrid grid={grid} tags={route.tags} />}
    </Columns>
  );
}
