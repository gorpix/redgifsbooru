// Sidebar of the creator and pool pages: the posts index's tag list and blacklist panel, with links
// that stay inside the page's scope and counts estimated from the scope's size (no per-tag lookups).
import type { TagCounts } from '../api/tagCounts';
import type { PostGridState } from './PostGrid';
import { BlacklistPanel, TagList } from './PostsSidebar';
import { hasFilters, matchRate, scopedBaseSize } from './postsHelpers';

interface Props {
  grid: PostGridState;
  tagCounts: TagCounts;
  /** Link of a search inside the scope. */
  searchHref(tags: string): string;
}

export function ScopedSidebar({ grid, tagCounts, searchHref }: Props) {
  const { pipeline, state, posts } = grid;
  const { query, queryText, mergeIndex, settings, allRules } = pipeline;
  const totals = pipeline.streamTotals();
  const rate = state ? matchRate(state) : undefined;
  const size = scopedBaseSize(totals, hasFilters(query), rate);
  return (
    <>
      <TagList
        posts={posts}
        query={query}
        queryText={queryText}
        tagCounts={tagCounts}
        canonical={pipeline.canonical}
        index={mergeIndex}
        streamTotals={totals}
        rate={rate}
        settled={state?.phase === 'done' || state?.phase === 'paused'}
        searchHref={searchHref}
        scope={{ size }}
      />
      <BlacklistPanel rules={allRules} enabled={settings.blacklistEnabled} hidden={state ? (state.rejected.blacklist ?? 0) : null} />
    </>
  );
}
