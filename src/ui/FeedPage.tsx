// /booru/feed: the newest posts of the creators I follow, merged (RedGifs has no such feed).
import { useEffect } from 'preact/hooks';
import type { RedgifsApi } from '../api/client';
import type { TagCounts } from '../api/tagCounts';
import { hrefFor, type Route, type Router } from '../router';
import { useAuthState, useFollowedNames } from './account';
import { gateNotice } from './accountHelpers';
import { Columns } from './Columns';
import { PostGrid, usePostGrid } from './PostGrid';
import { FOLLOWING_SOURCE } from './postsHelpers';
import { ScopedSidebar } from './ScopedSidebar';
import { SearchBox } from './SearchBox';
import { useSearchPipeline } from './searchPipeline';

const SITE = 'RedGIFsbooru';

interface Props {
  api: RedgifsApi;
  router: Router;
  tagCounts: TagCounts;
  route: Extract<Route, { name: 'feed' }>;
}

export function FeedPage({ api, router, tagCounts, route }: Props) {
  const { gate } = useAuthState();
  const notice = gateNotice(gate, 'feed');
  const followed = useFollowedNames(gate === 'ok');
  const nobody = !notice && followed.state === 'ready' && followed.names.length === 0;
  const pipeline = useSearchPipeline(route.tags, { api, source: FOLLOWING_SOURCE, enabled: !notice });
  const grid = usePostGrid(pipeline, route.page);

  useEffect(() => {
    document.title = `Feed${route.tags ? `: ${route.tags}` : ''} | ${SITE}${route.page > 1 ? ` – page ${route.page}` : ''}`;
  }, [route.tags, route.page]);

  const linkTo = (tags: string, page: number) => hrefFor({ name: 'feed', tags, page });
  const searchBox = (
    <SearchBox
      key={route.tags}
      api={api}
      router={router}
      tagCounts={tagCounts}
      initial={route.tags}
      placeholder="Search feed"
      submitHref={(text) => linkTo(text, 1)}
    />
  );

  const count = followed.names.length;
  const loadingFirst = !notice && !nobody && count > 0 && (!grid.state || (grid.state.phase === 'filling' && grid.state.posts.length === 0));

  return (
    <Columns
      api={api}
      router={router}
      tagCounts={tagCounts}
      route={route}
      searchBox={searchBox}
      searchTitle="Search feed"
      sidebar={notice || nobody ? null : <ScopedSidebar grid={grid} tagCounts={tagCounts} searchHref={(tags) => linkTo(tags, 1)} />}
    >
      <h1 class="rgb-title">Feed</h1>
      {notice && <div class="rgb-notice"><p>{notice}</p></div>}
      {!notice && followed.state === 'loading' && <p class="rgb-progress">Loading your followed creators…</p>}
      {!notice && followed.state === 'error' && <div class="rgb-notice error"><p>Could not load the creators you follow.</p></div>}
      {nobody && <p class="muted">You don't follow anyone yet.</p>}
      {!notice && !nobody && count > 0 && (
        <>
          {loadingFirst && <p class="rgb-progress">Loading {count} {count === 1 ? 'creator' : 'creators'}…</p>}
          <PostGrid grid={grid} tags={route.tags} linkTo={linkTo} src="following" />
        </>
      )}
    </Columns>
  );
}
