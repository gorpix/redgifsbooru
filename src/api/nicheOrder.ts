// A niche's posts can be ordered 'trending' on some deployments of the RedGifs API and not on others.
// The first time a niche stream is needed we try 'trending' with one request; if RedGifs rejects it
// (non-2xx) or answers with nothing at all (no posts, total 0) we use 'latest' instead. The outcome is
// remembered in localStorage so later page views do not probe again.
import type { GetOptions, RedgifsApi } from './client';
import { HttpError } from './http';
import type { SearchOrder, SearchPage } from './types';

export const NICHE_ORDER_KEY = 'rgb:niche-order';

export type NicheOrder = 'trending' | 'latest';
type Store = Pick<Storage, 'getItem' | 'setItem'>;

export function readNicheOrder(storage: Store | null): NicheOrder | null {
  try {
    const value = storage?.getItem(NICHE_ORDER_KEY);
    return value === 'trending' || value === 'latest' ? value : null;
  } catch {
    return null;
  }
}

function rememberNicheOrder(storage: Store | null, order: NicheOrder): void {
  try {
    storage?.setItem(NICHE_ORDER_KEY, order);
  } catch { /* storage full or blocked */ }
}

interface PageParams {
  /** Omit (or 'trending') for the default order, which is probed and remembered. */
  order?: SearchOrder;
  count?: number;
  page?: number;
}

/**
 * A niche page in `params.order`. For the default (undefined / 'trending') order, the remembered
 * working order is used, or probed once as described above. Any other order is passed through.
 */
export async function fetchNichePage(
  api: Pick<RedgifsApi, 'nicheGifs'>,
  id: string,
  params: PageParams = {},
  options: Pick<GetOptions, 'signal' | 'priority'> = {},
  storage: Store | null = null,
): Promise<SearchPage> {
  const { order, ...rest } = params;
  if (order && order !== 'trending') return api.nicheGifs(id, { ...rest, order }, options);

  const known = readNicheOrder(storage);
  if (known) return api.nicheGifs(id, { ...rest, order: known }, options);

  try {
    const first = await api.nicheGifs(id, { ...rest, order: 'trending' }, options);
    if (first.gifs.length > 0 || first.total > 0) {
      rememberNicheOrder(storage, 'trending');
      return first;
    }
    // Empty with total 0: treated as rejected.
  } catch (error) {
    // Only an HTTP rejection counts; rate limits, aborts and network errors are the caller's to handle.
    if (!(error instanceof HttpError)) throw error;
  }
  const fallback = await api.nicheGifs(id, { ...rest, order: 'latest' }, options);
  if (fallback.gifs.length > 0 || fallback.total > 0) rememberNicheOrder(storage, 'latest');
  return fallback;
}
