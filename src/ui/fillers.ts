// Keeps PageFiller instances alive between page changes so scanned state is reused.
import type { Gif } from '../api/types';
import { PageFiller, type FillState } from '../search/filler';

export interface FillerEntry {
  filler: PageFiller;
  /** Tail of the fills queued on this instance (a PageFiller is not re-entrant). */
  running: Promise<unknown> | null;
}

const MAX_ENTRIES = 10;
const entries = new Map<string, FillerEntry>();

export function getFiller(id: string, create: () => PageFiller): FillerEntry {
  const have = entries.get(id);
  if (have) {
    entries.delete(id); // refresh insertion order
    entries.set(id, have);
    return have;
  }
  const entry: FillerEntry = { filler: create(), running: null };
  entries.set(id, entry);
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value as string;
    entries.delete(oldest);
  }
  return entry;
}

/**
 * Runs filler.fill after any earlier fill on the same instance has settled.
 * Updates after the signal aborts are dropped; an abort resolves quietly with null.
 */
export function runFill(
  entry: FillerEntry,
  page: number,
  onUpdate: (state: FillState) => void,
  signal: AbortSignal,
): Promise<FillState | null> {
  const previous = entry.running;
  const task = (async () => {
    if (previous) await previous.catch(() => undefined);
    if (signal.aborted) return null;
    try {
      return await entry.filler.fill(page, (state) => { if (!signal.aborted) onUpdate(state); }, signal);
    } catch (error) {
      if (signal.aborted || (error as { name?: string })?.name === 'AbortError') return null;
      throw error;
    }
  })();
  entry.running = task;
  return task;
}

const MAX_REMEMBERED_PAGES = 20;
/** `${fillerId}|${page}` -> the posts of that finished page, oldest first (Map insertion order). */
const pages = new Map<string, Gif[]>();
const pageKey = (id: string, page: number) => `${id}|${page}`;

/**
 * Remembers the finished posts of one (fillerId, page) so the post page can find neighbours and
 * look posts up without a request. Keeps at most 20 pages; the oldest remembered are dropped.
 */
export function rememberPage(id: string, page: number, posts: Gif[]): void {
  const key = pageKey(id, page);
  pages.delete(key); // refresh order
  pages.set(key, posts);
  while (pages.size > MAX_REMEMBERED_PAGES) {
    pages.delete(pages.keys().next().value as string);
  }
}

/** Posts remembered for (fillerId, page), or undefined. */
export function pagePosts(id: string, page: number): Gif[] | undefined {
  return pages.get(pageKey(id, page));
}

/** A post by id from any remembered page (newest pages first), or undefined. */
export function findCached(gifId: string): Gif | undefined {
  for (const posts of [...pages.values()].reverse()) {
    const hit = posts.find((g) => g.id === gifId);
    if (hit) return hit;
  }
  return undefined;
}

/** Forgets every remembered page (tests). */
export function clearRememberedPages(): void {
  pages.clear();
}
