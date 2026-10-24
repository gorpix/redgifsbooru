import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { RedgifsApi } from '../api/client';
import type { TagCounts } from '../api/tagCounts';
import type { Gif } from '../api/types';
import { hrefFor, type Route, type Router } from '../router';
import { BUILTIN_CATEGORIES } from '../search/builtinCategories';
import { CATEGORY_COLOR, parseCategoryText } from '../search/categories';
import { addTagToQuery, excludeTagFromQuery } from '../search/edit';
import { favoriteScore, sortPage } from '../search/match';
import { distinctiveTags, formatAge } from './postHelpers';
import { toTagTerm } from '../search/tags';
import { getCategoryText, subscribeCategories } from '../store/categories';
import { getSettings, subscribeSettings, updateSettings } from '../store/settings';
import { Columns } from './Columns';
import { defaultStorage } from '../store/storage';
import { downloadFile } from './download';
import { findCached, pagePosts, rememberPage, runFill } from './fillers';
import { formatCount, formatDuration, formatNicheName } from './format';
import { useSubscription } from './hooks';
import { Player, useElementWidth } from './Player';
import {
  availableMediaHeight,
  canonicalKeys,
  downloadName,
  filterRelated,
  groupTagsByCategory,
  isSplitLayout,
  keyAction,
  locateNeighbour,
  pickUnknownCounts,
  postTitle,
  readPlayerPrefs,
  SCALE_LABEL,
  SCALE_MODES,
  updatePlayerPrefs,
  type ScaleMode,
  redgifsWatchUrl,
  resolveNeighbour,
  sourceFromSrc,
  spellingFor,
  streamLabel,
  visibleThumbCount,
  withoutPost,
} from './postPageHelpers';
import { useSearchPipeline, type SearchPipeline } from './searchPipeline';
import { scoreColor, Thumb } from './Thumb';

const SITE = 'RedGIFsbooru';
const LOOKUP_LIMIT = 8;
/** How long the Related row waits for tag counts before using whatever is known. */
const COUNT_WAIT_MS = 8000;

type PostRoute = Extract<Route, { name: 'post' }>;

interface Props {
  api: RedgifsApi;
  router: Router;
  tagCounts: TagCounts;
  route: PostRoute;
}

type Loaded =
  | { id: string; kind: 'ok'; gif: Gif }
  | { id: string; kind: 'error'; error: unknown };

export function PostPage({ api, router, tagCounts, route }: Props) {
  const pipeline = useSearchPipeline(route.q, { api, source: useMemo(() => sourceFromSrc(route.src), [route.src]) });
  const { mergeIndex } = pipeline;

  // The post: a remembered grid page first (no request), else one getGif.
  const cached = useMemo(() => findCached(route.id), [route.id]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (cached) return;
    let cancelled = false;
    api.getGif(route.id).then(
      ({ gif }) => { if (!cancelled) setLoaded({ id: route.id, kind: 'ok', gif }); },
      (error) => { if (!cancelled) setLoaded({ id: route.id, kind: 'error', error }); },
    );
    return () => { cancelled = true; };
  }, [api, route.id, retry, cached]);

  const gif = cached ?? (loaded?.id === route.id && loaded.kind === 'ok' ? loaded.gif : null);
  const failed = !cached && loaded?.id === route.id && loaded.kind === 'error' ? loaded.error : null;

  useEffect(() => {
    document.title = postTitle(route.id, gif ? gif.tags : null, SITE);
  }, [route.id, gif]);

  // Global counts for at most 8 tags per post view (chosen once per post so arriving counts do
  // not pull more lookups in).
  const chosen = useRef<{ id: string; keys: string[] }>({ id: '', keys: [] });
  if (gif && chosen.current.id !== gif.id) {
    chosen.current = { id: gif.id, keys: pickUnknownCounts(canonicalKeys(gif.tags, mergeIndex), (k) => tagCounts.get(k), LOOKUP_LIMIT) };
  }
  const lookupKeys = gif && chosen.current.id === gif.id ? chosen.current.keys : [];
  useEffect(() => {
    if (lookupKeys.length) tagCounts.request(lookupKeys);
  }, [gif?.id, tagCounts]);

  // "Always show related posts": the media gets the height left under the header, with the
  // description, prev/next bar and related rows still on screen. Measured, not guessed.
  useSubscription(subscribeSettings);
  const showRelatedBelow = getSettings().showRelatedBelow;
  const [scale, setScale] = useState<ScaleMode>(() => readPlayerPrefs(defaultStorage()).scale);
  const chooseScale = (mode: ScaleMode) => {
    setScale(mode);
    updatePlayerPrefs({ scale: mode }, defaultStorage());
  };
  const playerHost = useRef<HTMLDivElement>(null);
  const belowRef = useRef<HTMLDivElement>(null);
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  useEffect(() => {
    if (!showRelatedBelow || !gif) return;
    const host = playerHost.current;
    const below = belowRef.current;
    if (!host || !below) return;
    const measure = () => {
      setMaxHeight(availableMediaHeight({
        viewportHeight: window.innerHeight,
        above: host.getBoundingClientRect().top + window.scrollY,
        bar: 0,
        below: below.offsetHeight,
        // 2 border + 8 under the player + the margins around the prev/next bar and rows.
        margin: 40,
      }));
    };
    measure();
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(below);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [showRelatedBelow, gif?.id]);

  const sidebar = gif ? <PostSidebar gif={gif} route={route} tagCounts={tagCounts} pipeline={pipeline} lookupKeys={lookupKeys} scale={scale} onScale={chooseScale} showRelatedBelow={showRelatedBelow} /> : null;

  return (
    <Columns api={api} router={router} tagCounts={tagCounts} route={route} sidebar={sidebar}>
      {!gif && !failed && <p class="rgb-progress">Loading…</p>}
      {failed != null && (
        <div class="rgb-notice error">
          <p>Could not load post {route.id}. It may have been removed, or RedGifs is not answering.</p>
          <button type="button" onClick={() => { setLoaded(null); setRetry((n) => n + 1); }}>Retry</button>
          {' '}
          <a href={redgifsWatchUrl(route.id)} target="_blank" rel="noopener noreferrer">Open on RedGifs</a>
        </div>
      )}
      {gif && (
        <>
          <div ref={playerHost}>
            <Player key={gif.id} gif={gif} maxHeight={showRelatedBelow ? maxHeight : null} scale={scale} onScale={chooseScale} />
          </div>
          <div ref={belowRef}>
            {gif.description && <p class="rgb-description">{gif.description}</p>}
            <NavBar route={route} router={router} pipeline={pipeline} />
            <Related key={gif.id} api={api} tagCounts={tagCounts} gif={gif} pipeline={pipeline} route={route} lookupKeys={lookupKeys} />
          </div>
        </>
      )}
    </Columns>
  );
}

// ---------------------------------------------------------------- previous / next

type Dir = -1 | 1;

function NavBar({ route, router, pipeline }: { route: PostRoute; router: Router; pipeline: SearchPipeline }) {
  const { id: fillerId, entry } = pipeline;
  const [busy, setBusy] = useState<Dir | null>(null);
  /** Directions found to have nothing, for this post. */
  const [empty, setEmpty] = useState<{ id: string; dirs: Dir[] }>({ id: '', dirs: [] });
  const emptyDirs = empty.id === `${route.id}|${route.page}|${fillerId}` ? empty.dirs : [];
  const hasQuery = route.q !== '' || route.src !== '';

  const aborts = useRef(new AbortController());
  useEffect(() => {
    aborts.current = new AbortController();
    return () => aborts.current.abort();
  }, [route.id, fillerId]);

  const sortedFor = (posts: Gif[]) => (pipeline.query.pageSort ? sortPage(posts, pipeline.query.pageSort) : posts);

  const load = async (page: number): Promise<Gif[] | undefined> => {
    if (!entry) return undefined;
    const state = await runFill(entry, page, () => undefined, aborts.current.signal);
    if (!state) return undefined;
    const posts = sortedFor(state.posts);
    if (state.phase === 'done') rememberPage(fillerId, page, posts);
    return posts;
  };

  const go = async (dir: Dir) => {
    if (!hasQuery || busy) return;
    setBusy(dir);
    const signal = aborts.current.signal;
    try {
      const found = await resolveNeighbour(dir, route.id, route.page, (p) => pagePosts(fillerId, p), load);
      if (signal.aborted) return;
      if (found.kind === 'found') {
        router.navigate(hrefFor({ name: 'post', id: found.gif.id, q: route.q, page: found.page, src: route.src }));
      } else {
        setEmpty((e) => ({ id: `${route.id}|${route.page}|${fillerId}`, dirs: [...(e.id === `${route.id}|${route.page}|${fillerId}` ? e.dirs : []), dir] }));
      }
    } catch {
      if (!signal.aborted) {
        setEmpty((e) => ({ id: `${route.id}|${route.page}|${fillerId}`, dirs: [...(e.id === `${route.id}|${route.page}|${fillerId}` ? e.dirs : []), dir] }));
      }
    } finally {
      if (!signal.aborted) setBusy(null);
    }
  };

  // Keys. The handler reads the latest `go` through a ref so the listener is added once.
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    if (!hasQuery) return;
    const onKey = (event: KeyboardEvent) => {
      const action = keyAction(event);
      if (!action) return;
      event.preventDefault();
      void goRef.current(action === 'prev' ? -1 : 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasQuery]);

  if (!hasQuery) return null;

  /** The grid page the post came from. */
  const source = sourceFromSrc(route.src);
  const gridHref = source.kind === 'user'
    ? hrefFor({ name: 'user', user: source.name, tags: route.q, page: route.page })
    : source.kind === 'niche'
      ? hrefFor({ name: 'pool', id: source.id, tags: route.q, page: route.page })
      : hrefFor({ name: 'posts', tags: route.q, page: route.page });

  // Synchronous answers from remembered pages give real links (open in new tab etc.).
  const side = (dir: Dir, label: string) => {
    const found = resolveSync(dir, route, fillerId);
    if (found === 'none' || emptyDirs.includes(dir)) return <span class="disabled">{label}</span>;
    if (found) {
      return <a href={hrefFor({ name: 'post', id: found.gif.id, q: route.q, page: found.page, src: route.src })} rel={dir < 0 ? 'prev' : 'next'}>{label}</a>;
    }
    return (
      <button type="button" class="link-btn" disabled={busy !== null} onClick={() => { void go(dir); }}>
        {busy === dir ? '…' : label}
      </button>
    );
  };

  return (
    <nav class="rgb-postnav" aria-label="Previous and next post">
      {side(-1, '‹ Previous')}
      <span class="sep">|</span>
      <span class="query">
        {route.src === '' ? 'Search: ' : ''}
        <a href={gridHref}>{route.src === '' ? route.q : streamLabel(route.src)}</a>
        {route.src !== '' && route.q !== '' && <> ({route.q})</>}
      </span>
      <span class="sep">|</span>
      {side(1, 'Next ›')}
    </nav>
  );
}


/** Answer from remembered pages only: a neighbour, 'none', or null when a page must be loaded first. */
function resolveSync(dir: Dir, route: PostRoute, fillerId: string): { gif: Gif; page: number } | 'none' | null {
  const found = locateNeighbour(dir, route.id, route.page, (p) => pagePosts(fillerId, p));
  if (found.kind === 'found') return found;
  return found.kind === 'none' ? 'none' : null;
}

// ---------------------------------------------------------------- related rows

type RowState = { kind: 'loading' } | { kind: 'ok'; gifs: Gif[] } | { kind: 'hidden' };

function Related({ api, tagCounts, gif, pipeline, route, lookupKeys }: {
  api: RedgifsApi;
  tagCounts: TagCounts;
  gif: Gif;
  pipeline: SearchPipeline;
  route: PostRoute;
  lookupKeys: string[];
}) {
  const { mergeIndex } = pipeline;
  const [creator, setCreator] = useState<RowState>({ kind: 'loading' });
  const [related, setRelated] = useState<RowState>({ kind: 'loading' });
  const [relatedKeys, setRelatedKeys] = useState<string[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    const opts = { signal, priority: 'low' as const };
    const index = mergeIndex;

    api.userGifs(gif.userName, { count: 12, order: 'latest' }, opts).then(
      (page) => { if (!signal.aborted) setCreator({ kind: 'ok', gifs: withoutPost(page.gifs, gif.id) }); },
      () => { if (!signal.aborted) setCreator({ kind: 'hidden' }); },
    );

    // Related: wait (briefly) for the tag counts being looked up, then search once.
    let off: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      const keys = distinctiveTags(gif.tags, index, (k) => tagCounts.get(k), 2);
      if (signal.aborted) return;
      if (keys.length === 0) { setRelated({ kind: 'hidden' }); return; }
      setRelatedKeys(keys);
      try {
        const page = await api.searchGifs(
          { tags: keys.map((k) => spellingFor(k, gif.tags, index)), count: 24, order: 'trending' },
          opts,
        );
        if (!signal.aborted) setRelated({ kind: 'ok', gifs: filterRelated(page.gifs, keys, index, gif.id, 12) });
      } catch {
        if (!signal.aborted) setRelated({ kind: 'hidden' });
      }
    };
    const settled = () => lookupKeys.every((k) => tagCounts.get(k) !== undefined);
    if (settled()) {
      void run();
    } else {
      off = tagCounts.subscribe(() => {
        if (!settled()) return;
        off?.();
        clearTimeout(timer);
        void run();
      });
      timer = setTimeout(() => { off?.(); void run(); }, COUNT_WAIT_MS);
    }
    return () => {
      controller.abort();
      off?.();
      clearTimeout(timer);
    };
  }, [api, gif.id]);

  // Side by side when the main column is wide enough, stacked otherwise.
  // Only when both sections have posts, and each half would show at least 3 thumbnails.
  const [wrapRef, wrapWidth] = useElementWidth();
  const present = (r: RowState) => r.kind === 'loading' || (r.kind === 'ok' && r.gifs.length > 0);
  const split = present(creator) && present(related) && isSplitLayout(wrapWidth);
  return (
    <div class={`rgb-relatedwrap${split ? ' split' : ''}`} ref={wrapRef}>
      <Row
        title={<a href={`/booru/users/${encodeURIComponent(gif.userName)}`}>{`More from ${gif.userName}`}</a>}
        state={creator}
        route={route}
      />
      <Row title={relatedKeys.length ? `Related: ${relatedKeys.map(toTagTerm).join(' ')}` : 'Related'} state={related} route={route} />
    </div>
  );
}

/** Rows of thumbnails per related section. */
const RELATED_ROWS = 1;

function Row({ title, state, route }: { title: ComponentChildren; state: RowState; route: PostRoute }) {
  const [ref, width] = useElementWidth();
  // A row that failed or came back empty is hidden quietly.
  if (state.kind === 'hidden' || (state.kind === 'ok' && state.gifs.length === 0)) return null;
  return (
    <section class="rgb-related" ref={ref}>
      <h2>{title}</h2>
      {state.kind === 'loading'
        ? <p class="muted rgb-note">Loading…</p>
        : <div class="thumb-grid">{state.gifs.slice(0, visibleThumbCount(width, RELATED_ROWS)).map((g) => <Thumb key={g.id} gif={g} q={route.q} />)}</div>}
    </section>
  );
}

// ---------------------------------------------------------------- sidebar

function PostSidebar({ gif, route, tagCounts, pipeline, lookupKeys, scale, onScale, showRelatedBelow }: {
  gif: Gif;
  route: PostRoute;
  tagCounts: TagCounts;
  pipeline: SearchPipeline;
  lookupKeys: string[];
  scale: ScaleMode;
  onScale: (mode: ScaleMode) => void;
  showRelatedBelow: boolean;
}) {
  const categoriesVersion = useSubscription(subscribeCategories);
  const userCategories = useMemo(() => parseCategoryText(getCategoryText()), [categoriesVersion]);
  useSubscription(tagCounts.subscribe.bind(tagCounts));
  const groups = useMemo(
    () => groupTagsByCategory(gif.tags, BUILTIN_CATEGORIES, userCategories, pipeline.mergeIndex),
    [gif.id, userCategories, pipeline.mergeIndex],
  );

  const search = (tags: string) => hrefFor({ name: 'posts', tags, page: 1 });
  const creatorColor = CATEGORY_COLOR.creator;

  return (
    <>
      <section class="rgb-taggroups">
        <h2 style={{ color: creatorColor }}>Creator</h2>
        <ul class="rgb-tags">
          <li>
            <span class="wiki" title="Creator">?</span>
            <a
              class="name"
              style={{ color: creatorColor }}
              href={`/booru/users/${encodeURIComponent(gif.userName)}`}
            >
              {gif.userName}
            </a>
          </li>
        </ul>
        {groups.map((group) => (
          <div key={group.category}>
            <h2 class="rgb-taghead" style={{ color: CATEGORY_COLOR[group.category] }}>{group.label}</h2>
            <ul class="rgb-tags">
              {group.tags.map((row) => {
                const count = tagCounts.get(row.key);
                return (
                  <li key={row.key}>
                    <a class="wiki" href={`/booru/wiki/${encodeURIComponent(toTagTerm(row.key))}`} title="Tag wiki">?</a>
                    <a class="op" href={search(addTagToQuery(route.q, row.key))} title="Add to search">+</a>
                    <a class="op" href={search(excludeTagFromQuery(route.q, row.key))} title="Exclude from search">–</a>
                    <a class="name" style={{ color: CATEGORY_COLOR[group.category] }} href={search(toTagTerm(row.key))}>{row.name}</a>
                    <span class="count" title="Posts on RedGifs">
                      {count === undefined ? (lookupKeys.includes(row.key) ? '…' : '') : count === null ? '?' : formatCount(count)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </section>
      <InfoSection gif={gif} />
      <DisplaySection scale={scale} onScale={onScale} showRelatedBelow={showRelatedBelow} />
      <OptionsSection gif={gif} />
      {gif.niches?.length > 0 && (
        <section>
          <h2>Niches</h2>
          <ul class="rgb-list rgb-niches">
            {gif.niches.map((n) => (
              <li key={n}>
                <a href={`/booru/pools/${encodeURIComponent(n)}`}>{formatNicheName(n)}</a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function InfoSection({ gif }: { gif: Gif }) {
  const score = favoriteScore(gif);
  const posted = Number.isFinite(gif.createDate) ? new Date(gif.createDate * 1000) : null;
  const absolute = posted ? posted.toISOString().slice(0, 16).replace('T', ' ') : '';
  return (
    <section>
      <h2>Information</h2>
      <table class="rgb-info">
        <tbody>
          <tr><th>ID</th><td>{gif.id}</td></tr>
          <tr>
            <th>Creator</th>
            <td>{gif.userName}{gif.verified && <span class="verified" title="Verified creator"> ✓</span>}</td>
          </tr>
          {posted && (
            <tr>
              <th>Posted</th>
              <td title={`${absolute} UTC`}>{formatAge(gif.createDate, Date.now())}<br /><span class="muted">{absolute}</span></td>
            </tr>
          )}
          {gif.type !== 2 && <tr><th>Duration</th><td>{formatDuration(gif.duration)}</td></tr>}
          <tr><th>Size</th><td>{gif.width}×{gif.height}</td></tr>
          <tr><th>Audio</th><td>{gif.hasAudio ? 'yes' : 'no'}</td></tr>
          <tr><th>Views</th><td>{formatCount(gif.views)}</td></tr>
          <tr><th>Favorites</th><td>{formatCount(gif.likes)}</td></tr>
          <tr>
            <th>Score</th>
            <td
              title="Score: favourites per view vs. a typical post; 50 = typical, +25 = twice as many"
              style={score === null ? undefined : { color: scoreColor(score), fontWeight: 'bold' }}
            >
              {score === null ? '–' : score}
            </td>
          </tr>
          <tr><th>Type</th><td>{gif.type === 2 ? 'image' : 'video'}</td></tr>
        </tbody>
      </table>
    </section>
  );
}

function DisplaySection({ scale, onScale, showRelatedBelow }: {
  scale: ScaleMode;
  onScale: (mode: ScaleMode) => void;
  showRelatedBelow: boolean;
}) {
  return (
    <section>
      <h2>Display</h2>
      <ul class="rgb-list rgb-display" aria-label="Media size">
        {SCALE_MODES.map((mode) => (
          <li key={mode}>
            {mode === scale
              ? <b aria-current="true">{SCALE_LABEL[mode]}</b>
              : <button type="button" class="link-btn" onClick={() => onScale(mode)}>{SCALE_LABEL[mode]}</button>}
          </li>
        ))}
        <li>
          <label>
            <input
              type="checkbox"
              checked={showRelatedBelow}
              onChange={(e) => updateSettings({ showRelatedBelow: e.currentTarget.checked })}
            />
            {' '}Always show related posts
          </label>
        </li>
      </ul>
    </section>
  );
}

function OptionsSection({ gif }: { gif: Gif }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(redgifsWatchUrl(gif.id));
    } catch {
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  const isImage = gif.type === 2;
  const hd = gif.urls.hd ?? (isImage ? gif.urls.sd : undefined);
  const sd = gif.urls.sd;
  return (
    <section>
      <h2>Options</h2>
      <ul class="rgb-list rgb-options">
        <li><a href={redgifsWatchUrl(gif.id)} target="_blank" rel="noopener noreferrer">Open on RedGifs</a></li>
        {hd && (
          <li>
            <button type="button" class="link-btn" onClick={() => downloadFile(hd, downloadName(gif.id, isImage ? 'image' : 'hd'))}>
              {isImage ? 'Download image' : 'Download HD'}
            </button>
          </li>
        )}
        {!isImage && sd && sd !== hd && (
          <li>
            <button type="button" class="link-btn" onClick={() => downloadFile(sd, downloadName(gif.id, 'sd'))}>Download SD</button>
          </li>
        )}
        <li>
          <button type="button" class="link-btn" onClick={() => { void copy(); }}>{copied ? 'Copied' : 'Copy link'}</button>
        </li>
      </ul>
    </section>
  );
}
