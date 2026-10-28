import { useEffect } from 'preact/hooks';
import type { RedgifsApi } from '../api/client';
import type { TagCounts } from '../api/tagCounts';
import { POPULAR_SCALES, hrefFor, type Route, type Router } from '../router';
import { POPULAR_LABEL, popularTags } from './browseHelpers';
import { Columns } from './Columns';
import { PostGrid, usePostGrid } from './PostGrid';
import { BlacklistPanel, FiltersPanel, TagList } from './PostsSidebar';
import { matchRate } from './postsHelpers';
import { useSearchPipeline } from './searchPipeline';

const SITE = 'RedGIFsbooru';

interface Props {
  api: RedgifsApi;
  router: Router;
  tagCounts: TagCounts;
  route: Extract<Route, { name: 'popular' }>;
}

/**
 * Popular posts: the first page of the server order for the scale (day trending, week top7, month
 * top28), no tags. Further pages are the posts index with the same `order:` search (paginator links).
 */
export function PopularPage({ api, router, tagCounts, route }: Props) {
  const tags = popularTags(route.scale);
  const pipeline = useSearchPipeline(tags, { api });
  const grid = usePostGrid(pipeline, 1);
  const { query, queryText, mergeIndex, settings, allRules } = pipeline;
  const { state, posts } = grid;

  useEffect(() => {
    document.title = `Popular – ${POPULAR_LABEL[route.scale].toLowerCase()} | ${SITE}`;
  }, [route.scale]);

  const sidebar = (
    <>
      <TagList posts={posts} query={query} queryText={queryText} tagCounts={tagCounts} canonical={pipeline.canonical} index={mergeIndex} streamTotals={pipeline.streamTotals()} rate={state ? matchRate(state) : undefined} settled={state?.phase === 'done' || state?.phase === 'paused'} />
      <FiltersPanel rejected={state ? state.rejected : null} />
      <BlacklistPanel rules={allRules} enabled={settings.blacklistEnabled} hidden={state ? (state.rejected.blacklist ?? 0) : null} />
    </>
  );

  return (
    <Columns api={api} router={router} tagCounts={tagCounts} route={route} sidebar={sidebar}>
      <h1 class="rgb-title">Popular posts</h1>
      <nav class="rgb-tabs" aria-label="Time range">
        {POPULAR_SCALES.map((scale) => (
          <a key={scale} href={hrefFor({ name: 'popular', scale })} class={scale === route.scale ? 'active' : ''}>{POPULAR_LABEL[scale]}</a>
        ))}
        <span class="rgb-spacer" />
        <a href={hrefFor({ name: 'posts', tags, page: 1 })}>View all posts</a>
      </nav>
      <PostGrid grid={grid} tags={tags} />
    </Columns>
  );
}
