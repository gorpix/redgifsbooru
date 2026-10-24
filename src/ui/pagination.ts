export type PaginatorItem = number | 'gap' | 'more';

/**
 * Page numbers to show. Known end: 1 … current±2 … last. Unknown end: 1 … current±2,
 * the furthest known page, then 'more' (meaning "there may be more").
 */
export function paginatorItems(current: number, knownPages: number, lastPage: number | null): PaginatorItem[] {
  const cur = Math.max(1, Math.floor(current) || 1);
  const top = lastPage !== null ? Math.max(1, lastPage) : Math.max(knownPages, cur);
  const set = new Set<number>([1, top]);
  for (let p = cur - 2; p <= cur + 2; p++) if (p >= 1 && p <= top) set.add(p);
  const pages = [...set].sort((a, b) => a - b);
  const out: PaginatorItem[] = [];
  pages.forEach((p, i) => {
    if (i > 0 && p - pages[i - 1] > 1) out.push('gap');
    out.push(p);
  });
  if (lastPage === null) out.push('more');
  return out;
}
