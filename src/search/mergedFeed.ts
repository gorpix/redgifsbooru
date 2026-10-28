// The "Feed": several creators' newest-first streams merged into one newest-first stream, offered to
// the PageFiller as VIRTUAL pages of VIRTUAL_PAGE_SIZE items.
//
// Virtual page n = items [(n-1)*30, n*30) of the merge of every creator's stream ordered by
// createDate desc (ties by id), deduped by id. The merge is built incrementally and only ever
// appended to, so earlier virtual pages never change, however the later ones are reached. A
// creator's next server page is fetched only when its buffer is empty and it has more pages, so a
// first virtual page costs about one request per creator and later ones only what runs out.
import type { Gif } from '../api/types';
import type { FetchStreamPage, StreamPage } from './filler';

export const VIRTUAL_PAGE_SIZE = 30;

/** One creator's stream: server page `page` (1-based) of their newest-first posts. */
export type CreatorFetcher = (page: number, signal: AbortSignal) => Promise<{ gifs: Gif[]; pages: number }>;

interface CreatorState {
  fetch: CreatorFetcher;
  /** Items fetched but not merged yet, newest first. */
  buffer: Gif[];
  /** Next server page to fetch. */
  next: number;
  ended: boolean;
}

/** createDate desc, then id. */
export function compareFeedGifs(a: Gif, b: Gif): number {
  return b.createDate - a.createDate || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

/**
 * A FetchStreamPage over the virtual pages of the merged creators. `pages` is the number of virtual
 * pages known so far + 1 while some creator has more to give, the exact count once all are exhausted.
 * Calls are serialised (the filler is not re-entrant anyway), and a call that fails or is aborted
 * leaves the merge untouched apart from pages already fetched, which are kept.
 */
export function createMergedFeed(fetchers: CreatorFetcher[], pageSize = VIRTUAL_PAGE_SIZE): FetchStreamPage {
  const creators: CreatorState[] = fetchers.map((fetch) => ({ fetch, buffer: [], next: 1, ended: false }));
  const merged: Gif[] = [];
  const seen = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();

  const exhausted = () => creators.every((c) => c.ended && c.buffer.length === 0);

  /** Fetches the next page of every creator whose buffer ran out (in parallel). */
  async function refill(signal: AbortSignal): Promise<void> {
    const empty = creators.filter((c) => c.buffer.length === 0 && !c.ended);
    if (empty.length === 0) return;
    const results = await Promise.allSettled(empty.map(async (c) => {
      const page = c.next;
      const res = await c.fetch(page, signal);
      // Commit even if aborted meanwhile: it is correct data and saves a request next time.
      c.next = page + 1;
      c.buffer = res.gifs.slice().sort(compareFeedGifs);
      const pages = typeof res.pages === 'number' && Number.isFinite(res.pages) ? res.pages : 0;
      if (res.gifs.length === 0 || (pages > 0 && page >= pages)) c.ended = true;
    }));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
    if (signal.aborted) throw abortError(signal);
  }

  /** Appends to `merged` until it holds `count` items or every creator is exhausted. */
  async function extend(count: number, signal: AbortSignal): Promise<void> {
    while (merged.length < count) {
      if (signal.aborted) throw abortError(signal);
      await refill(signal);
      // Every live creator now has a buffered head (an exhausted one has none).
      let best: CreatorState | null = null;
      for (const c of creators) {
        if (c.buffer.length > 0 && (!best || compareFeedGifs(c.buffer[0], best.buffer[0]) < 0)) best = c;
      }
      if (!best) return; // all exhausted
      const gif = best.buffer.shift() as Gif;
      if (seen.has(gif.id)) continue;
      seen.add(gif.id);
      merged.push(gif);
    }
  }

  const run = async (page: number, signal: AbortSignal): Promise<StreamPage> => {
    if (signal.aborted) throw abortError(signal);
    const from = (page - 1) * pageSize;
    await extend(from + pageSize, signal);
    const gifs = merged.slice(from, from + pageSize);
    const knownPages = Math.max(1, Math.ceil(merged.length / pageSize));
    return { gifs, pages: exhausted() ? knownPages : knownPages + 1 };
  };

  return (page, signal) => {
    const result = queue.then(() => run(page, signal));
    queue = result.catch(() => undefined);
    return result;
  };
}
