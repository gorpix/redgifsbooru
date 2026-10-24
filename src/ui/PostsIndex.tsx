import { useEffect } from 'preact/hooks';
import type { RedgifsApi } from '../api/client';
import type { TagCounts } from '../api/tagCounts';
import type { Route, Router } from '../router';
import { Columns } from './Columns';
import { PostGrid, usePostGrid } from './PostGrid';
import { BlacklistPanel, SavedSearches, TagList } from './PostsSidebar';
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
  const pipeline = useSearchPipeline(route.tags, { api });
  const { query, queryText, mergeIndex, settings, allRules } = pipeline;
  const grid = usePostGrid(pipeline, route.page);
  const { state, posts } = grid;

  useEffect(() => {
    const base = queryText || 'Posts';
    document.title = `${base} | ${SITE}${route.page > 1 ? ` – page ${route.page}` : ''}`;
  }, [queryText, route.page]);

  const sidebar = (
    <>
      <SavedSearches query={query} />
      <TagList posts={posts} query={query} queryText={queryText} tagCounts={tagCounts} canonical={pipeline.canonical} index={mergeIndex} streamTotals={pipeline.streamTotals()} rate={state ? matchRate(state) : undefined} settled={state?.phase === 'done' || state?.phase === 'paused'} />
      <BlacklistPanel rules={allRules} enabled={settings.blacklistEnabled} hidden={state ? (state.rejected.blacklist ?? 0) : null} />
    </>
  );

  return (
    <Columns api={api} router={router} tagCounts={tagCounts} route={route} sidebar={sidebar}>
      <h1 class="rgb-title">{queryText ? `Posts: ${queryText}` : 'Posts'}</h1>
      <PostGrid grid={grid} tags={route.tags} />
    </Columns>
  );
}
