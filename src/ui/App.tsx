import { useEffect, useMemo, useState } from 'preact/hooks';
import type { RedgifsApi } from '../api/client';
import type { AuthManager } from '../api/auth';
import type { TagCounts } from '../api/tagCounts';
import type { AccountSet } from '../store/account';
import type { Route, Router } from '../router';
import { AccountContext, useAuthState } from './account';
import { Columns } from './Columns';
import { CreatorPage } from './CreatorPage';
import { FeedPage } from './FeedPage';
import { FavoritesPage } from './FavoritesPage';
import { FollowingPage } from './FollowingPage';
import { Layout } from './Layout';
import { NotFound } from './NotFound';
import { PoolPage } from './PoolPage';
import { PoolsPage } from './PoolsPage';
import { PopularPage } from './PopularPage';
import { PostPage } from './PostPage';
import { PostsIndex } from './PostsIndex';
import { SetPage } from './SetPage';
import { SetsPage } from './SetsPage';
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
    case 'favorites':
    case 'feed':
    case 'following':
    case 'sets':
    case 'set':
    case 'popular': return null;
    case 'pools': return `Pools | ${SITE}`;
    case 'notFound': return `Not found | ${SITE}`;
  }
}

interface Props {
  api: RedgifsApi;
  router: Router;
  tagCounts: TagCounts;
  /** Login state (phase 5). */
  auth: AuthManager;
  /** My liked posts and followed creators (phase 5). */
  likes: AccountSet;
  follows: AccountSet;
}

/** Loads my likes once the user is logged in, so hearts show their state. */
function LikesLoader({ likes }: { likes: AccountSet }) {
  const { state } = useAuthState();
  useEffect(() => {
    if (state === 'loggedIn') void likes.ensureLoaded();
  }, [state, likes]);
  return null;
}

export function App({ api, router, tagCounts, auth, likes, follows }: Props) {
  const account = useMemo(() => ({ auth, likes, follows }), [auth, likes, follows]);
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
      page = <Columns api={api} router={router} tagCounts={tagCounts} route={route}><SettingsPage tagCounts={tagCounts} auth={auth} api={api} /></Columns>;
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
    case 'favorites':
      page = <FavoritesPage api={api} router={router} tagCounts={tagCounts} route={route} />;
      break;
    case 'feed':
      page = <FeedPage api={api} router={router} tagCounts={tagCounts} route={route} />;
      break;
    case 'following':
      page = <FollowingPage api={api} router={router} tagCounts={tagCounts} route={route} />;
      break;
    case 'sets':
      page = <SetsPage api={api} router={router} tagCounts={tagCounts} route={route} />;
      break;
    case 'set':
      page = <SetPage api={api} router={router} tagCounts={tagCounts} route={route} />;
      break;
    case 'notFound':
      page = <Columns api={api} router={router} tagCounts={tagCounts} route={route}><NotFound /></Columns>;
      break;
  }

  return (
    <AccountContext.Provider value={account}>
      <LikesLoader likes={likes} />
      <Layout route={route}>{page}</Layout>
    </AccountContext.Provider>
  );
}
