import { useEffect } from 'preact/hooks';
import type { RedgifsApi } from '../api/client';
import type { TagCounts } from '../api/tagCounts';
import { hrefFor, type Route, type Router } from '../router';
import { POOLS_PER_PAGE, poolsPaging } from './browseHelpers';
import { Columns } from './Columns';
import { formatCount, formatNicheName } from './format';
import { Paginator } from './Paginator';
import { errorMessage } from './postsHelpers';
import { useLoad } from './useLoad';

interface Props {
  api: RedgifsApi;
  router: Router;
  tagCounts: TagCounts;
  route: Extract<Route, { name: 'pools' }>;
}

export function PoolsPage({ api, router, tagCounts, route }: Props) {
  const data = useLoad(`pools:${route.page}`, (signal) => api.niches({ count: POOLS_PER_PAGE, page: route.page }, { signal }));
  const paging = poolsPaging(route.page, data.status === 'ok' ? data.value.pages : 0);

  // A page number past the end shows the last page instead of an empty table.
  useEffect(() => {
    if (data.status === 'ok' && paging.pages > 0 && route.page > paging.pages) {
      router.navigate(hrefFor({ name: 'pools', page: paging.page }), { replace: true });
    }
  }, [data.status, paging.pages, paging.page, route.page]);

  return (
    <Columns api={api} router={router} tagCounts={tagCounts} route={route}>
      <h1 class="rgb-title">Pools</h1>
      {data.status === 'loading' && <p class="rgb-progress">Loading pools…</p>}
      {data.status === 'error' && (
        <div class="rgb-notice error">
          <p>{errorMessage(data.error)}</p>
          <button type="button" onClick={data.retry}>Retry</button>
        </div>
      )}
      {data.status === 'ok' && (
        <>
          <p class="muted rgb-note">{formatCount(data.value.total)} pools. Pools are RedGifs niches.</p>
          <table class="rgb-pools">
            <thead>
              <tr><th class="thumb-col" /><th>Name</th><th class="num">Posts</th><th class="num">Subscribers</th></tr>
            </thead>
            <tbody>
              {data.value.niches.map((niche) => (
                <tr key={niche.id}>
                  <td class="thumb-col">
                    {niche.thumbnail && <img src={niche.thumbnail} loading="lazy" alt="" />}
                  </td>
                  <td><a href={hrefFor({ name: 'pool', id: niche.id, tags: '', page: 1 })}>{formatNicheName(niche.name || niche.id)}</a></td>
                  <td class="num">{formatCount(niche.gifs)}</td>
                  <td class="num">{formatCount(niche.subscribers)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.value.niches.length === 0 && <p class="muted">No pools on this page.</p>}
          {paging.pages > 1 && (
            <Paginator href={(page) => hrefFor({ name: 'pools', page })} current={paging.page} knownPages={paging.pages} lastPage={paging.pages} />
          )}
        </>
      )}
    </Columns>
  );
}
