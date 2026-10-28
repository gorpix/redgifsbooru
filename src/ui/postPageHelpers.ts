// Pure helpers for the post page (kept out of the components so they can be tested).
import type { Gif } from '../api/types';
import { categoryOf, CATEGORY_LABEL, CATEGORY_ORDER, type Category } from '../search/categories';
import type { MergeIndex } from '../search/merges';
import { normalizeTag } from '../search/tags';
import type { PostSrc, Route } from '../router';
import { formatNicheName, tagToken } from './format';
import { neighbours } from './postHelpers';
import type { Source } from './postsHelpers';

// ---------------------------------------------------------------- tag groups

export interface TagRow {
  /** Merge-canonical normalized key (used for counts and for + / - edits). */
  key: string;
  /** Shown name: the key, with spaces. */
  name: string;
}

export interface TagGroup {
  category: Category;
  label: string;
  tags: TagRow[];
}

/**
 * The post's tags grouped by category in CATEGORY_ORDER, empty groups left out. Tags are merged to
 * their canonical key (so two spellings of one merge group show once); order inside a group is the
 * post's tag order.
 */
export function groupTagsByCategory(
  gifTags: readonly string[],
  builtin: Readonly<Record<string, Category>>,
  user: Readonly<Record<string, Category>>,
  index: MergeIndex,
): TagGroup[] {
  const byCategory = new Map<Category, TagRow[]>();
  const seen = new Set<string>();
  for (const raw of gifTags) {
    const own = normalizeTag(raw);
    const key = index.canonical(own);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // `creator` is only for the userName; a tag mapped there is listed as general.
    let category = categoryOf(own, builtin, user, index);
    if (category === 'creator') category = 'general';
    const list = byCategory.get(category) ?? [];
    list.push({ key, name: key });
    byCategory.set(category, list);
  }
  return CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((c) => ({
    category: c,
    label: CATEGORY_LABEL[c],
    tags: sortTagRows(byCategory.get(c) as TagRow[]),
  }));
}

/** The merge-canonical keys of a post's tags, deduplicated, in post order. */
export function canonicalKeys(gifTags: readonly string[], index: MergeIndex): string[] {
  const out: string[] = [];
  for (const raw of gifTags) {
    const key = index.canonical(normalizeTag(raw));
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

/** Keys whose global count is not known yet, at most `limit`, in the given order. */
export function pickUnknownCounts(
  keys: readonly string[],
  countOf: (key: string) => number | null | undefined,
  limit = 8,
): string[] {
  return keys.filter((k) => countOf(k) === undefined).slice(0, limit);
}

// ---------------------------------------------------------------- keys

export interface KeyEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: object | null;
}

/** What a key press means on the post page: previous / next post, or nothing. */
export function keyAction(event: KeyEventLike): 'prev' | 'next' | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  const target = event.target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
  const tag = target?.tagName?.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return null;
  switch (event.key) {
    case 'ArrowLeft':
    case 'a':
    case 'A':
      return 'prev';
    case 'ArrowRight':
    case 'd':
    case 'D':
      return 'next';
    default:
      return null;
  }
}

// ---------------------------------------------------------------- downloads and links

export type DownloadKind = 'hd' | 'sd' | 'image';

/** File name for a download: `<id>.mp4`, `<id>-sd.mp4`, `<id>.jpg`. */
export function downloadName(id: string, kind: DownloadKind): string {
  switch (kind) {
    case 'hd': return `${id}.mp4`;
    case 'sd': return `${id}-sd.mp4`;
    case 'image': return `${id}.jpg`;
  }
}

export function redgifsWatchUrl(id: string): string {
  return `https://www.redgifs.com/watch/${encodeURIComponent(id)}`;
}

/** `<first 3 tags> - post <id> | RedGIFsbooru`; just `post <id> | ...` while the tags are unknown. */
export function postTitle(id: string, tags: readonly string[] | null, site: string): string {
  const first = (tags ?? []).slice(0, 3).map(tagToken).join(' ');
  return `${first ? `${first} – ` : ''}post ${id} | ${site}`;
}

// ---------------------------------------------------------------- player preferences

/** fit: inside the box; width: fill the width; height: fill the height; original: natural size. */
export type ScaleMode = 'fit' | 'width' | 'height' | 'original';
export const SCALE_MODES: readonly ScaleMode[] = ['fit', 'width', 'height', 'original'];
export const SCALE_LABEL: Record<ScaleMode, string> = { fit: 'Fit', width: 'Fit width', height: 'Fit height', original: 'Original' };

export interface PlayerPrefs {
  muted: boolean;
  /** 0..1 */
  volume: number;
  scale: ScaleMode;
}

export const PLAYER_KEY = 'rgb:player';
export const DEFAULT_PLAYER_PREFS: PlayerPrefs = { muted: true, volume: 1, scale: 'fit' };

/** Reads stored player prefs; anything unusable gives the defaults (muted, full volume, fit). */
export function parsePlayerPrefs(text: string | null | undefined): PlayerPrefs {
  try {
    const raw = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_PLAYER_PREFS };
    const volume = Number(raw.volume);
    return {
      muted: typeof raw.muted === 'boolean' ? raw.muted : DEFAULT_PLAYER_PREFS.muted,
      volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : DEFAULT_PLAYER_PREFS.volume,
      scale: SCALE_MODES.includes(raw.scale as ScaleMode) ? (raw.scale as ScaleMode) : DEFAULT_PLAYER_PREFS.scale,
    };
  } catch {
    return { ...DEFAULT_PLAYER_PREFS };
  }
}

type PrefsStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Stored prefs (defaults when nothing is saved or storage is blocked). */
export function readPlayerPrefs(storage: PrefsStorage | null): PlayerPrefs {
  try {
    return parsePlayerPrefs(storage?.getItem(PLAYER_KEY));
  } catch {
    return { ...DEFAULT_PLAYER_PREFS };
  }
}

/** Merges `patch` into the stored prefs (so changing the scale keeps volume / mute and vice versa). */
export function updatePlayerPrefs(patch: Partial<PlayerPrefs>, storage: PrefsStorage | null): PlayerPrefs {
  const next = { ...readPlayerPrefs(storage), ...patch };
  try {
    storage?.setItem(PLAYER_KEY, JSON.stringify(next));
  } catch {
    // storage blocked or full
  }
  return next;
}

// ---------------------------------------------------------------- player sizing

export interface Size { width: number; height: number }

/**
 * Displayed size of the media. `box` is the room available (height may be Infinity for no limit).
 * fit: shrink to fit inside the box, never enlarge; width: exactly the box width; height: exactly
 * the box height; original: natural size. Unusable sizes give null (let the browser decide).
 */
export function fitSize(mode: ScaleMode, box: Size, media: Size): Size | null {
  if (!(media.width > 0) || !(media.height > 0)) return null;
  if (mode === 'original') return { width: media.width, height: media.height };
  const byWidth = box.width > 0 ? box.width / media.width : null;
  const byHeight = box.height > 0 && Number.isFinite(box.height) ? box.height / media.height : null;
  let scale: number | null;
  if (mode === 'width') scale = byWidth;
  else if (mode === 'height') scale = byHeight ?? byWidth;
  else {
    const both = [byWidth, byHeight].filter((v): v is number => v !== null);
    scale = both.length ? Math.min(1, ...both) : 1;
  }
  if (scale === null) return null;
  return { width: Math.round(media.width * scale), height: Math.round(media.height * scale) };
}

/**
 * Height left for the media so what lies below it stays on screen: viewport minus everything above
 * it (header, nav), the bar over it, what is below (description, prev/next bar, related rows) and
 * margins. Never smaller than `min`.
 */
export function availableMediaHeight(p: {
  viewportHeight: number;
  above: number;
  bar: number;
  below: number;
  margin?: number;
  min?: number;
}): number {
  const h = p.viewportHeight - p.above - p.bar - p.below - (p.margin ?? 16);
  return Math.max(p.min ?? 160, Math.floor(h));
}

// ---------------------------------------------------------------- related layout

export const THUMB_WIDTH = 150;
export const THUMB_GAP = 6;
export const SPLIT_GAP = 12;
/** Fewest thumbnails each half must show for the two related sections to go side by side. */
export const SPLIT_MIN_THUMBS = 3;

/** How many thumbnails fit side by side in a row of `width` px (at least 1). */
export function thumbsPerRow(width: number, thumb = THUMB_WIDTH, gap = THUMB_GAP): number {
  if (!Number.isFinite(width) || width <= 0) return 1;
  return Math.max(1, Math.floor((width + gap) / (thumb + gap)));
}

/** How many thumbnails to render: whole rows only. */
export function visibleThumbCount(width: number, rows = 1, thumb = THUMB_WIDTH, gap = THUMB_GAP): number {
  return thumbsPerRow(width, thumb, gap) * Math.max(1, rows);
}

/**
 * True when the two related sections go side by side: only if each half (the column minus the gap,
 * divided by two) would still show at least SPLIT_MIN_THUMBS thumbnails. Otherwise they stack.
 */
export function isSplitLayout(columnWidth: number, gap = SPLIT_GAP): boolean {
  if (!Number.isFinite(columnWidth) || columnWidth <= 0) return false;
  return visibleThumbCount((columnWidth - gap) / 2) >= SPLIT_MIN_THUMBS;
}

// ---------------------------------------------------------------- tag order

/** Alphabetical by shown name, case-insensitive (e621 default); a new array. */
export function sortTagRows(rows: readonly TagRow[]): TagRow[] {
  const key = (r: TagRow) => r.name.toLowerCase();
  return [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// ---------------------------------------------------------------- related posts

/**
 * RedGifs' spelling of a normalized key as it appears on the post (so no tag lookup is needed to
 * build the search); falls back to a tag of the same merge group, then to the key itself.
 */
export function spellingFor(key: string, gifTags: readonly string[], index: MergeIndex): string {
  const exact = gifTags.find((t) => normalizeTag(t) === key);
  if (exact) return exact;
  const grouped = gifTags.find((t) => index.canonical(normalizeTag(t)) === key);
  return grouped ?? key;
}

/** True when the post carries every key (compared merge-canonically). */
export function carriesTags(gif: Pick<Gif, 'tags'>, keys: readonly string[], index: MergeIndex): boolean {
  const have = new Set((gif.tags ?? []).map((t) => index.canonical(normalizeTag(t))));
  return keys.every((k) => have.has(index.canonical(k)));
}

/** Related-row posts: carry all `keys`, are not the current post, no duplicates, at most `max`. */
export function filterRelated(
  gifs: readonly Gif[],
  keys: readonly string[],
  index: MergeIndex,
  excludeId: string,
  max = 12,
): Gif[] {
  const seen = new Set<string>([excludeId]);
  const out: Gif[] = [];
  for (const gif of gifs) {
    if (seen.has(gif.id) || !carriesTags(gif, keys, index)) continue;
    seen.add(gif.id);
    out.push(gif);
    if (out.length >= max) break;
  }
  return out;
}

/** The creator's other posts: not the current post, at most `max`. */
export function withoutPost(gifs: readonly Gif[], excludeId: string, max = 12): Gif[] {
  return gifs.filter((g) => g.id !== excludeId).slice(0, max);
}

// ---------------------------------------------------------------- prev / next

export type Located =
  | { kind: 'found'; gif: Gif; page: number }
  | { kind: 'none' }
  /** The answer needs this grid page, which is not remembered yet. */
  | { kind: 'unknown'; needPage: number };

/**
 * The post before (dir -1) or after (dir +1) `id`, given the grid page it was opened from.
 * `pageOf(p)` returns the remembered posts of grid page p. Inside the page it is the plain
 * neighbour; at an edge it is the last / first post of page - 1 / + 1.
 */
export function locateNeighbour(
  dir: -1 | 1,
  id: string,
  page: number,
  pageOf: (page: number) => readonly Gif[] | undefined,
): Located {
  const list = pageOf(page);
  if (!list) return { kind: 'unknown', needPage: page };
  if (!list.some((g) => g.id === id)) return { kind: 'none' };
  const n = neighbours(list as Gif[], id);
  const hit = dir < 0 ? n.prev : n.next;
  if (hit) return { kind: 'found', gif: hit, page };
  const other = page + dir;
  if (other < 1) return { kind: 'none' };
  const next = pageOf(other);
  if (!next) return { kind: 'unknown', needPage: other };
  if (next.length === 0) return { kind: 'none' };
  return { kind: 'found', gif: dir < 0 ? next[next.length - 1] : next[0], page: other };
}

/**
 * locateNeighbour, loading missing grid pages with `load(page)` (at most two: the post's own page
 * and one neighbour). `load` returns the page's posts, or undefined when it cannot be had.
 */
export async function resolveNeighbour(
  dir: -1 | 1,
  id: string,
  page: number,
  pageOf: (page: number) => readonly Gif[] | undefined,
  load: (page: number) => Promise<readonly Gif[] | undefined>,
): Promise<Located> {
  const loaded = new Map<number, readonly Gif[]>();
  const lookup = (p: number) => pageOf(p) ?? loaded.get(p);
  for (let i = 0; i < 3; i++) {
    const found = locateNeighbour(dir, id, page, lookup);
    if (found.kind !== 'unknown') return found;
    const posts = await load(found.needPage);
    if (!posts) return { kind: 'none' };
    loaded.set(found.needPage, posts);
  }
  return { kind: 'none' };
}

// ---------------------------------------------------------------- where a post was opened from

/** The stream a post's `?src=` names, for the search pipeline (prev/next uses the grid's own filler). */
export function sourceFromSrc(src: PostSrc): Source {
  if (src === 'liked') return { kind: 'liked' };
  if (src === 'following') return { kind: 'following' };
  if (src.startsWith('user:')) return { kind: 'user', name: src.slice(5) };
  if (src.startsWith('niche:')) return { kind: 'niche', id: src.slice(6) };
  if (src.startsWith('set:')) return { kind: 'set', id: src.slice(4) };
  return { kind: 'search' };
}

/** The prev/next bar's label for the stream: 'Search', the creator's name, 'Pool: <name>', 'Favorites' or 'Set'. */
export function streamLabel(src: PostSrc): string {
  const source = sourceFromSrc(src);
  switch (source.kind) {
    case 'user': return source.name;
    case 'niche': return `Pool: ${formatNicheName(source.id)}`;
    case 'liked': return 'Favorites';
    case 'following': return 'Feed';
    case 'set': return 'Set';
    case 'search': return 'Search';
  }
}

/** The grid page a post was opened from, as a route (for the prev/next bar's middle link). */
export function gridRouteFor(source: Source, q: string, page: number): Route {
  switch (source.kind) {
    case 'user': return { name: 'user', user: source.name, tags: q, page };
    case 'niche': return { name: 'pool', id: source.id, tags: q, page };
    case 'liked': return { name: 'favorites', tags: q, page };
    case 'following': return { name: 'feed', tags: q, page };
    case 'set': return { name: 'set', id: source.id, tags: q, page };
    case 'search': return { name: 'posts', tags: q, page };
  }
}
