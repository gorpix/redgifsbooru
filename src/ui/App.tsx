import { useEffect, useState } from 'preact/hooks';
import type { RedgifsApi } from '../api/client';
import type { TagCounts } from '../api/tagCounts';
import type { Route, Router } from '../router';
import { Columns } from './Columns';
import { CreatorPage } from './CreatorPage';
import { Layout } from './Layout';
import { NotFound } from './NotFound';
import { PoolPage } from './PoolPage';
import { PoolsPage } from './PoolsPage';
import { PopularPage } from './PopularPage';
import { PostPage } from './PostPage';
import { PostsIndex } from './PostsIndex';
import { SettingsPage } from './SettingsPage';
import { WikiIndex, WikiPage } from './WikiPage';

const SITE = 'RedGIFsbooru';

/** The posts index sets its own title (it depends on the search). */
function titleFor(route: Route): string | null {
  switch (route.name) {
    case 'posts': return null;
    case 'post': return null; // PostPage sets its own title (it depends on the post's tags)
    case 'settings': return `Settings | ${SITE}`;
    // These pages set their own titles (they depend on what they load).
    case 'wikiIndex':
    case 'wiki':
    case 'user':
    case 'pool':
    case 'popular': return null;
    case 'pools': return `Pools | ${SITE}`;
    case 'notFound': return `Not found | ${SITE}`;
  }
}

interface Props {
  api: RedgifsApi;
  router: Router;
  tagCounts: TagCounts;
}

export function App({ api, router, tagCounts }: Props) {
  const [route, setRoute] = useState<Route>(router.route);

  useEffect(() => {
    setRoute(router.route);
    return router.subscribe(setRoute);
  }, [router]);

  useEffect(() => {
    const title = titleFor(route);
    if (title) document.title = title;
  }, [route]);

  let page;
  switch (route.name) {
    case 'posts':
      page = <PostsIndex api={api} router={router} tagCounts={tagCounts} route={route} />;
      break;
    case 'post':
      page = <PostPage api={api} router={router} tagCounts={tagCounts} route={route} />;
      break;
    case 'settings':
      page = <Columns api={api} router={router} tagCounts={tagCounts} route={route}><SettingsPage tagCounts={tagCounts} /></Columns>;
      break;
    case 'wikiIndex':
      page = <WikiIndex api={api} router={router} tagCounts={tagCounts} route={route} />;
      break;
    case 'wiki':
      page = <WikiPage api={api} router={router} tagCounts={tagCounts} route={route} />;
      break;
    case 'user':
      page = <CreatorPage api={api} router={router} tagCounts={tagCounts} route={route} />;
      break;
    case 'pools':
      page = <PoolsPage api={api} router={router} tagCounts={tagCounts} route={route} />;
      break;
    case 'pool':
      page = <PoolPage api={api} router={router} tagCounts={tagCounts} route={route} />;
      break;
    case 'popular':
      page = <PopularPage api={api} router={router} tagCounts={tagCounts} route={route} />;
      break;
    case 'notFound':
      page = <Columns api={api} router={router} tagCounts={tagCounts} route={route}><NotFound /></Columns>;
      break;
  }

  return <Layout route={route}>{page}</Layout>;
}
