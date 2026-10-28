// /booru/favorites: my RedGifs favorites as a posts grid (`fav:me` plus the page's own tags).
import { useEffect } from 'preact/hooks';
import type { RedgifsApi } from '../api/client';
import type { TagCounts } from '../api/tagCounts';
import { hrefFor, type Route, type Router } from '../router';
import { formatQuery } from '../search/query';
import { useAuthState } from './account';
import { gateNotice } from './accountHelpers';
import { Columns } from './Columns';
import { PostGrid, usePostGrid } from './PostGrid';
import { LIKED_SOURCE } from './postsHelpers';
import { ScopedSidebar } from './ScopedSidebar';
import { SearchBox } from './SearchBox';
import { useSearchPipeline } from './searchPipeline';

const SITE = 'RedGIFsbooru';

interface Props {
  api: RedgifsApi;
  router: Router;
  tagCounts: TagCounts;
  route: Extract<Route, { name: 'favorites' }>;
}

export function FavoritesPage({ api, router, tagCounts, route }: Props) {
  const { gate } = useAuthState();
  const notice = gateNotice(gate, 'favorites');
  const pipeline = useSearchPipeline(route.tags, { api, source: LIKED_SOURCE, enabled: !notice });
  const grid = usePostGrid(pipeline, route.page);

  // The search as the user typed it (the page's own `fav:me` is implied).
  const shown = formatQuery({ ...pipeline.query, fav: false });
  useEffect(() => {
    document.title = `Favorites${shown ? `: ${shown}` : ''} | ${SITE}${route.page > 1 ? ` – page ${route.page}` : ''}`;
  }, [shown, route.page]);

  const linkTo = (tags: string, page: number) => hrefFor({ name: 'favorites', tags, page });
  const searchBox = (
    <SearchBox
      key={route.tags}
      api={api}
      router={router}
      tagCounts={tagCounts}
      initial={route.tags}
      placeholder="Search favorites"
      submitHref={(text) => linkTo(text, 1)}
    />
  );

  return (
    <Columns
      api={api}
      router={router}
      tagCounts={tagCounts}
      route={route}
      searchBox={searchBox}
      searchTitle="Search favorites"
      sidebar={notice ? null : <ScopedSidebar grid={grid} tagCounts={tagCounts} searchHref={(tags) => linkTo(tags, 1)} />}
    >
      <h1 class="rgb-title">{shown ? `Favorites: ${shown}` : 'Favorites'}</h1>
      {notice
        ? <div class="rgb-notice"><p>{notice}</p></div>
        : <PostGrid grid={grid} tags={route.tags} linkTo={linkTo} src="liked" />}
    </Columns>
  );
}
