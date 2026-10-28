// /booru/sets/:id: one of my sets as a posts grid (source { kind: 'set' }), with an Edit mode that
// edits the set's details and adds a "remove" button under each thumbnail.
import { useEffect, useState } from 'preact/hooks';
import type { RedgifsApi } from '../api/client';
import type { TagCounts } from '../api/tagCounts';
import type { Gif } from '../api/types';
import { hrefFor, type Route, type Router } from '../router';
import { formatQuery } from '../search/query';
import { useAuthState } from './account';
import { gateNotice, setMembership, visibilityLabel } from './accountHelpers';
import { Columns } from './Columns';
import { formatCount } from './format';
import { PostGrid, usePostGrid } from './PostGrid';
import { bumpSetRevision, errorMessage } from './postsHelpers';
import { ScopedSidebar } from './ScopedSidebar';
import { SearchBox } from './SearchBox';
import { useSearchPipeline } from './searchPipeline';
import { SetForm } from './SetsPage';
import { useLoad } from './useLoad';

const SITE = 'RedGIFsbooru';

interface Props {
  api: RedgifsApi;
  router: Router;
  tagCounts: TagCounts;
  route: Extract<Route, { name: 'set' }>;
}

function RemoveButton({ onRemove }: { onRemove: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <div class="thumb-remove">
      <button
        type="button"
        class="link-btn"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setFailed(null);
          onRemove().then(() => setBusy(false), (error) => { setFailed(errorMessage(error)); setBusy(false); });
        }}
      >
        {busy ? 'removing…' : 'remove'}
      </button>
      {failed && <span class="error"> {failed}</span>}
    </div>
  );
}

export function SetPage({ api, router, tagCounts, route }: Props) {
  const id = route.id;
  const { gate } = useAuthState();
  const notice = gateNotice(gate, 'sets');
  // Bumped after the set changes: reloads the header and rebuilds the grid's filler.
  const [rev, setRev] = useState(0);
  const [editing, setEditing] = useState(false);

  const pipeline = useSearchPipeline(route.tags, { api, source: { kind: 'set', id }, enabled: !notice });
  const grid = usePostGrid(pipeline, route.page);
  // One request (the set's details); none while the account gate shows a notice.
  const info = useLoad(`set|${id}|${rev}|${notice ? 'x' : 'ok'}`, async () => (notice ? null : api.account.collection(id)));
  const set = info.status === 'ok' ? info.value : null;
  const title = set?.name ?? 'Set';

  const shown = formatQuery({ ...pipeline.query, fav: false });
  useEffect(() => {
    document.title = `Set: ${title}${shown ? ` – ${shown}` : ''} | ${SITE}${route.page > 1 ? ` – page ${route.page}` : ''}`;
  }, [title, shown, route.page]);

  const linkTo = (tags: string, page: number) => hrefFor({ name: 'set', id, tags, page });
  const searchBox = (
    <SearchBox
      key={`${id}|${route.tags}`}
      api={api}
      router={router}
      tagCounts={tagCounts}
      initial={route.tags}
      placeholder="Search this set"
      submitHref={(text) => linkTo(text, 1)}
    />
  );

  const removeFromSet = (gif: Gif) => async () => {
    await api.account.removeFromCollection(id, [gif.id]);
    setMembership.remove(gif.id, id);
    bumpSetRevision(id);
    setRev((n) => n + 1);
  };

  return (
    <Columns
      api={api}
      router={router}
      tagCounts={tagCounts}
      route={route}
      searchBox={searchBox}
      searchTitle="Search set"
      sidebar={notice ? null : <ScopedSidebar grid={grid} tagCounts={tagCounts} searchHref={(tags) => linkTo(tags, 1)} />}
    >
      <h1 class="rgb-title">Set: {title}</h1>
      {notice && <div class="rgb-notice"><p>{notice}</p></div>}
      {!notice && info.status === 'loading' && <p class="rgb-progress">Loading set…</p>}
      {!notice && info.status === 'error' && (
        <div class="rgb-notice error">
          <p>{errorMessage(info.error)}</p>
          <button type="button" onClick={info.retry}>Retry</button>
        </div>
      )}
      {!notice && info.status === 'ok' && !set && <p class="muted">You have no set with this id. <a href={hrefFor({ name: 'sets' })}>Back to your sets</a></p>}
      {set && (
        <div class="rgb-set-head">
          {editing ? (
            <SetForm
              initial={{ name: set.name, description: set.description ?? '', published: set.published }}
              submitLabel="Save"
              onCancel={() => setEditing(false)}
              onSubmit={async (fields) => {
                await api.account.updateCollection(id, { folderName: fields.name, description: fields.description || null, published: fields.published });
                setEditing(false);
                setRev((n) => n + 1);
              }}
            />
          ) : (
            <>
              {set.description && <p class="rgb-pool-desc">{set.description}</p>}
              <p class="muted">
                {visibilityLabel(set.published)}
                {set.count !== null && <> · {formatCount(set.count)} posts</>}
                {' · '}
                <a href={hrefFor({ name: 'sets' })}>All sets</a>
              </p>
            </>
          )}
          <p>
            <button type="button" class="link-btn" onClick={() => setEditing((on) => !on)}>
              {editing ? 'Done editing' : 'Edit'}
            </button>
            {editing && <span class="muted"> Edit mode: each thumbnail has a "remove" link.</span>}
          </p>
        </div>
      )}
      <h2 class="rgb-section">{shown ? `Posts: ${shown}` : 'Posts'}</h2>
      {!notice && (
        <PostGrid
          grid={grid}
          tags={route.tags}
          linkTo={linkTo}
          src={`set:${id}`}
          thumbAction={editing ? (gif) => <RemoveButton key={gif.id} onRemove={removeFromSet(gif)} /> : undefined}
        />
      )}
    </Columns>
  );
}
