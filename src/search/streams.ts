// Combines several server streams (one per tag combination) into one stream for the PageFiller.
import type { Gif } from '../api/types';
import type { FetchStreamPage, StreamPage } from './filler';
import type { ServerOrder } from './query';

/**
 * Combined page n = union of every stream's page n (streams known to have ended are skipped),
 * deduped by id. 'latest' is ordered by createDate desc; otherwise stream 0's items come first,
 * then stream 1's (each in their own order). pages = max of the streams' pages.
 * A single stream is passed through unchanged.
 */
export function combineStreams(fetchers: FetchStreamPage[], order: ServerOrder): FetchStreamPage {
  if (fetchers.length === 1) return fetchers[0];
  // First page number at which each stream is known to have no items.
  const endsAt: number[] = fetchers.map(() => Infinity);
  let maxPages = 0;

  return async (page: number, signal: AbortSignal): Promise<StreamPage> => {
    const active: number[] = [];
    fetchers.forEach((_, i) => { if (page < endsAt[i]) active.push(i); });
    if (active.length === 0) return { gifs: [], pages: maxPages };

    const results = await Promise.all(active.map((i) => fetchers[i](page, signal)));
    const lists: Gif[][] = [];
    results.forEach((res, k) => {
      const i = active[k];
      if (typeof res.pages === 'number' && Number.isFinite(res.pages)) {
        maxPages = Math.max(maxPages, res.pages);
        endsAt[i] = Math.min(endsAt[i], res.pages + 1);
      }
      if (res.gifs.length === 0) endsAt[i] = Math.min(endsAt[i], page);
      lists.push(res.gifs);
    });

    let all = lists.flat();
    if (order === 'latest') {
      all = all
        .map((g, i) => ({ g, i }))
        .sort((a, b) => b.g.createDate - a.g.createDate || a.i - b.i)
        .map((x) => x.g);
    }
    const seen = new Set<string>();
    const gifs = all.filter((g) => {
      if (seen.has(g.id)) return false;
      seen.add(g.id);
      return true;
    });
    return { gifs, pages: maxPages };
  };
}
