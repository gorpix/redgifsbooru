import { useEffect } from 'preact/hooks';
import type { RedgifsApi } from '../api/client';
import type { TagCounts } from '../api/tagCounts';
import { hrefFor, type Route, type Router } from '../router';
import { toTagTerm } from '../search/tags';
import { Columns } from './Columns';
import { formatCount, formatNicheName } from './format';
import { PostGrid, usePostGrid } from './PostGrid';
import { errorMessage } from './postsHelpers';
import { SearchBox } from './SearchBox';
import { ScopedSidebar } from './ScopedSidebar';
import { useSearchPipeline } from './searchPipeline';
import { useLoad } from './useLoad';

const SITE = 'RedGIFsbooru';

interface Props {
  api: RedgifsApi;
  router: Router;
  tagCounts: TagCounts;
  route: Extract<Route, { name: 'pool' }>;
}

export function PoolPage({ api, router, tagCounts, route }: Props) {
  const id = route.id;
  const pipeline = useSearchPipeline(route.tags, { api, source: { kind: 'niche', id } });
  const grid = usePostGrid(pipeline, route.page);
  const niche = useLoad(`niche:${id.toLowerCase()}`, (signal) => api.niche(id, { signal }));

  const info = niche.status === 'ok' ? niche.value : null;
  const title = formatNicheName(info?.name || id);
  useEffect(() => {
    const suffix = route.page > 1 ? ` – page ${route.page}` : '';
    document.title = `Pool: ${title}${pipeline.queryText ? ` – ${pipeline.queryText}` : ''} | ${SITE}${suffix}`;
  }, [title, pipeline.queryText, route.page]);

  const linkTo = (tags: string, page: number) => hrefFor({ name: 'pool', id, tags, page });
  const searchBox = (
    <SearchBox
      key={`${id}|${route.tags}`}
      api={api}
      router={router}
      tagCounts={tagCounts}
      initial={route.tags}
      placeholder="Search this pool"
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
      searchTitle="Search pool"
      sidebar={<ScopedSidebar grid={grid} tagCounts={tagCounts} searchHref={(tags) => linkTo(tags, 1)} />}
    >
      <h1 class="rgb-title">Pool: {title}</h1>
      {niche.status === 'loading' && <p class="rgb-progress">Loading pool…</p>}
      {niche.status === 'error' && (
        <div class="rgb-notice error">
          <p>{errorMessage(niche.error)}</p>
          <button type="button" onClick={niche.retry}>Retry</button>
        </div>
      )}
      {niche.status === 'ok' && !info && <p class="muted">No pool named {id} on RedGifs.</p>}
      {info && (
        <div class="rgb-pool-head">
          {info.description && <p class="rgb-pool-desc">{info.description}</p>}
          <p class="muted">
            {formatCount(info.gifs)} posts · {formatCount(info.subscribers)} subscribers
            {info.owner && <> · by {info.owner}</>}
          </p>
          {info.rules.length > 0 && (
            <details class="rgb-pool-rules">
              <summary>Rules ({info.rules.length})</summary>
              <ol>{info.rules.map((rule, i) => <li key={i}>{rule}</li>)}</ol>
            </details>
          )}
          {info.tags.length > 0 && (
            <p class="rgb-pool-tags">
              {'Tags: '}
              {info.tags.map((tag, i) => (
                <span key={tag}>
                  {i > 0 && ', '}
                  <a href={linkTo(toTagTerm(tag), 1)} title={`Search this pool for ${toTagTerm(tag)}`}>{tag.replace(/[_-]/g, ' ')}</a>
                </span>
              ))}
            </p>
          )}
        </div>
      )}
      <h2 class="rgb-section">{pipeline.queryText ? `Posts: ${pipeline.queryText}` : 'Posts'}</h2>
      <PostGrid grid={grid} tags={route.tags} linkTo={linkTo} src={`niche:${id}`} />
    </Columns>
  );
}
