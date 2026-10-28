// Loading my sets (RedGifs collections): all pages, 50 per request, at most MAX_SET_PAGES requests.
import type { RedgifsApi } from '../api/client';
import type { Collection } from '../api/types';

export const MAX_SET_PAGES = 10;

export async function loadAllSets(api: RedgifsApi, signal?: AbortSignal): Promise<Collection[]> {
  const first = await api.account.collections({ page: 1, count: 50 });
  const out = [...first.collections];
  for (let page = 2; page <= Math.min(first.pages, MAX_SET_PAGES); page++) {
    if (signal?.aborted) break;
    const next = await api.account.collections({ page, count: 50 });
    out.push(...next.collections);
  }
  // RedGifs could repeat a set across pages while the list changes.
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}
