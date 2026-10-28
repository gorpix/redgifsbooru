// /booru/following: the creators I follow on RedGifs (one request per page of 100).
import { useEffect } from 'preact/hooks';
import type { RedgifsApi } from '../api/client';
import type { TagCounts } from '../api/tagCounts';
import { hrefFor, type Route, type Router } from '../router';
import { useAuthState } from './account';
import { gateNotice } from './accountHelpers';
import { Columns } from './Columns';
import { FollowButton } from './FollowButton';
import { formatCount } from './format';
import { Paginator } from './Paginator';
import { errorMessage } from './postsHelpers';
import { useLoad } from './useLoad';

const SITE = 'RedGIFsbooru';

interface Props {
  api: RedgifsApi;
  router: Router;
  tagCounts: TagCounts;
  route: Extract<Route, { name: 'following' }>;
}

function FollowingList({ api, page }: { api: RedgifsApi; page: number }) {
  const list = useLoad(`following|${page}`, () => api.account.following({ page, count: 100 }));
  if (list.status === 'loading') return <p class="rgb-progress">Loading…</p>;
  if (list.status === 'error') {
    return (
      <div class="rgb-notice error">
        <p>{errorMessage(list.error)}</p>
        <button type="button" onClick={list.retry}>Retry</button>
      </div>
    );
  }
  const { items, pages, total } = list.value;
  if (items.length === 0) {
    return <p class="muted">{page > 1 ? 'There are no more creators.' : 'You are not following anyone yet. Use Follow on a creator page.'}</p>;
  }
  return (
    <>
      <p class="muted rgb-note">{formatCount(total)} {total === 1 ? 'creator' : 'creators'}</p>
      <table class="rgb-pools rgb-following">
        <thead>
          <tr><th class="thumb-col" /><th>Creator</th><th class="num">Posts</th><th class="num">Followers</th><th /></tr>
        </thead>
        <tbody>
          {items.map((user) => (
            <tr key={user.username}>
              <td class="thumb-col">
                {user.profileImageUrl && <img src={user.profileImageUrl} loading="lazy" alt="" />}
              </td>
              <td>
                <a href={hrefFor({ name: 'user', user: user.username, tags: '', page: 1 })}>{user.username}</a>
                {user.verified && <span class="rgb-verified" title="Verified creator"> ✓</span>}
              </td>
              <td class="num">{formatCount(user.posts)}</td>
              <td class="num">{formatCount(user.followers)}</td>
              <td class="num"><FollowButton name={user.username} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {(pages > 1 || page > 1) && (
        <Paginator href={(p) => hrefFor({ name: 'following', page: p })} current={page} knownPages={Math.max(pages, page)} lastPage={Math.max(pages, 1)} />
      )}
    </>
  );
}

export function FollowingPage({ api, router, tagCounts, route }: Props) {
  const { gate } = useAuthState();
  const notice = gateNotice(gate, 'followed creators');
  useEffect(() => {
    document.title = `Following${route.page > 1 ? ` – page ${route.page}` : ''} | ${SITE}`;
  }, [route.page]);
  return (
    <Columns api={api} router={router} tagCounts={tagCounts} route={route}>
      <h1 class="rgb-title">Following</h1>
      {notice
        ? <div class="rgb-notice"><p>{notice}</p></div>
        : <FollowingList api={api} page={route.page} />}
    </Columns>
  );
}
