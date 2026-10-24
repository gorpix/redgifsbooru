import type { ComponentChildren } from 'preact';
import type { RedgifsApi } from '../api/client';
import type { TagCounts } from '../api/tagCounts';
import type { Route, Router } from '../router';
import { RateLimitBanner } from './RateLimitBanner';
import { SearchBox } from './SearchBox';

interface Props {
  api: RedgifsApi;
  router: Router;
  tagCounts: TagCounts;
  route: Route;
  /** Replaces the default search box (which searches all posts), e.g. a box scoped to one creator. */
  searchBox?: ComponentChildren;
  /** Heading of the search section. */
  searchTitle?: string;
  /** Page-specific sidebar sections, shown below the search box. */
  sidebar?: ComponentChildren;
  children: ComponentChildren;
}

/** Two-column body shared by every page: search box + page sidebar, then the main content. */
export function Columns({ api, router, tagCounts, route, searchBox, searchTitle = 'Search', sidebar, children }: Props) {
  const tags = route.name === 'posts' ? route.tags : route.name === 'post' ? route.q : '';
  return (
    <div class="rgb-columns">
      <aside class="rgb-sidebar">
        <section>
          <h2>{searchTitle}</h2>
          {searchBox ?? <SearchBox key={tags} api={api} router={router} tagCounts={tagCounts} initial={tags} />}
        </section>
        {sidebar}
      </aside>
      <main class="rgb-main">
        <RateLimitBanner api={api} />
        {children}
      </main>
    </div>
  );
}
