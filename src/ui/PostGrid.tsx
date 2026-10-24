// The grid part of a posts listing, shared by the posts index, creator pages, pool pages and the
// popular page: runs the filler for one page, then shows alias / merge notes, tag problems, progress,
// the thumbnails and the paginator. `usePostGrid` is the logic, `PostGrid` the markup, so a page can
// build its sidebar from the same posts and fill state.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { hrefFor, type PostSrc } from '../router';
import { replaceTagInQuery } from '../search/edit';
import type { FillState } from '../search/filler';
import { sortPage } from '../search/match';
import type { Gif } from '../api/types';
import { normalizeTag, toTagTerm } from '../search/tags';
import { addUserAlias } from '../store/aliases';
import { rememberPage, runFill } from './fillers';
import { Paginator } from './Paginator';
import { errorMessage, mergeNote, pageSortAlias, progressText } from './postsHelpers';
import type { SearchPipeline } from './searchPipeline';
import { Thumb } from './Thumb';

export interface PostGridState {
  pipeline: SearchPipeline;
  page: number;
  /** null until the first update of this page arrives. */
  state: FillState | null;
  /** The page's posts in the order shown (page sort applied). */
  posts: Gif[];
  /** Scan again after a pause or an error. */
  rescan(): void;
}

/** Fills `page` of the pipeline's stream and remembers the finished page (for the post page's neighbours). */
export function usePostGrid(pipeline: SearchPipeline, page: number): PostGridState {
  const { query, id, entry } = pipeline;
  const fillKey = `${id}|${page}`;
  const [fill, setFill] = useState<{ key: string; state: FillState } | null>(null);
  const [rescan, setRescan] = useState(0);

  useEffect(() => {
    if (!entry) return;
    const controller = new AbortController();
    runFill(entry, page, (state) => setFill({ key: fillKey, state }), controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [entry, page, rescan]);

  const state = fill && fill.key === fillKey && entry ? fill.state : null;

  const posts = useMemo(
    () => (state ? (query.pageSort ? sortPage(state.posts, query.pageSort) : state.posts) : []),
    [state, query],
  );

  // Remember the finished page (in the order shown, page sorts applied) so the post page can find
  // neighbours without a request.
  useEffect(() => {
    if (state?.phase === 'done') rememberPage(id, page, posts);
  }, [state, posts, id, page]);

  return { pipeline, page, state, posts, rescan: () => setRescan((n) => n + 1) };
}

interface Props {
  grid: PostGridState;
  /** The search text of the grid (carried in the post links, edited by did-you-mean links). */
  tags: string;
  /** Link to the same grid with another search / page; the posts index links to /booru/posts. */
  linkTo?: (tags: string, page: number) => string;
  /** Stream of the grid (creator / pool), carried in the post links so prev/next stays in it. */
  src?: PostSrc;
}

const postsLink = (tags: string, page: number) => hrefFor({ name: 'posts', tags, page });

export function PostGrid({ grid, tags, linkTo = postsLink, src = '' }: Props) {
  const { pipeline, page, state, posts } = grid;
  const { aliased, merged, query, mergeIndex, validation } = pipeline;

  const notice = (() => {
    if (!validation) return <p class="rgb-progress">Checking tags…</p>;
    if (validation.kind === 'error') {
      return (
        <div class="rgb-notice error">
          <p>{errorMessage(validation.error)}</p>
          <button type="button" onClick={pipeline.retryValidation}>Retry</button>
        </div>
      );
    }
    if (validation.kind === 'unknown') {
      return (
        <div class="rgb-notice">
          {validation.unknown.map(({ key, suggestions }) => {
            const options = suggestions.filter((s) => normalizeTag(s.text) !== key).slice(0, 4);
            return (
              <p key={key}>
                No tag named {toTagTerm(key)}.
                {options.length > 0 && (
                  <>
                    {' Did you mean: '}
                    {options.map((s, i) => (
                      <span key={s.text}>
                        {i > 0 && ', '}
                        <a href={linkTo(replaceTagInQuery(tags, key, s.text), 1)}>{toTagTerm(s.text)}</a>
                        {' '}
                        <a
                          class="rgb-always"
                          href={linkTo(replaceTagInQuery(tags, key, s.text), 1)}
                          title={`Always search ${toTagTerm(s.text)} when I type ${toTagTerm(key)}`}
                          onClick={() => addUserAlias(key, normalizeTag(s.text))}
                        >
                          (always)
                        </a>
                      </span>
                    ))}
                    ?
                  </>
                )}
              </p>
            );
          })}
        </div>
      );
    }
    return null;
  })();

  const progress = state ? progressText(state) : null;
  const blacklisted = state?.rejected.blacklist ?? 0;
  const showPaginator = !!state && state.phase !== 'error' && (posts.length > 0 || page > 1);

  return (
    <>
      {(aliased.applied.length > 0 || merged.applied.length > 0) && (
        <p class="muted rgb-note rgb-alias-note">
          {aliased.applied.length > 0 && (
            <>
              {'Searching '}
              {aliased.applied.map((a) => toTagTerm(a.to)).join(', ')}
              {' for '}
              {aliased.applied.map((a) => toTagTerm(a.from)).join(', ')}.
              {merged.applied.length > 0 && ' '}
            </>
          )}
          {mergeNote(merged.applied, mergeIndex)}
        </p>
      )}
      {notice}
      {validation?.kind === 'ok' && !state && <p class="rgb-progress">Loading…</p>}
      {state && progress && (
        <p class={state.phase === 'error' ? 'rgb-progress error' : 'rgb-progress'}>
          {progress}
          {state.phase === 'done' && state.posts.length === 0 && blacklisted > 0 && (
            <> {blacklisted} {blacklisted === 1 ? 'post was' : 'posts were'} hidden by your blacklist.</>
          )}
          {state.phase === 'paused' && <> <button type="button" onClick={grid.rescan}>Keep scanning</button></>}
          {state.phase === 'error' && <> <button type="button" onClick={grid.rescan}>Retry</button></>}
        </p>
      )}
      {query.pageSort && (
        <p class="muted rgb-note">
          {pageSortAlias(query, query.pageSort)} sorts within this page; RedGifs can't sort a search by {query.pageSort.split('-')[0]}.
        </p>
      )}
      <div class="thumb-grid">
        {posts.map((gif) => <Thumb key={gif.id} gif={gif} q={tags} page={page} src={src} />)}
      </div>
      {showPaginator && state && (
        <Paginator href={(p) => linkTo(tags, p)} current={page} knownPages={state.knownPages} lastPage={state.lastPage} />
      )}
    </>
  );
}
