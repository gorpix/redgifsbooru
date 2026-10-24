import { hrefFor } from '../router';
import { paginatorItems } from './pagination';

interface Props {
  /** Search for the default (posts) links; ignored when `href` is given. */
  tags?: string;
  /** Link of a page, for grids that are not the posts index. */
  href?: (page: number) => string;
  current: number;
  knownPages: number;
  lastPage: number | null;
}

export function Paginator({ tags = '', href: pageHref, current, knownPages, lastPage }: Props) {
  const href = pageHref ?? ((page: number) => hrefFor({ name: 'posts', tags, page }));
  const items = paginatorItems(current, knownPages, lastPage);
  const nextDisabled = lastPage !== null && current >= lastPage;
  return (
    <nav class="paginator" aria-label="Pages">
      {current > 1 ? <a href={href(current - 1)} rel="prev">« Previous</a> : <span class="disabled">« Previous</span>}
      {items.map((item, i) => {
        if (item === 'gap') return <span key={`g${i}`} class="gap">…</span>;
        if (item === 'more') return <span key="more" class="gap" title="There may be more pages">≥</span>;
        return item === current
          ? <strong key={item} class="current">{item}</strong>
          : <a key={item} href={href(item)}>{item}</a>;
      })}
      {nextDisabled ? <span class="disabled">Next »</span> : <a href={href(current + 1)} rel="next">Next »</a>}
    </nav>
  );
}
