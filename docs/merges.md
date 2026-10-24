# Tag merges — contract

Merges join REAL RedGifs tags that mean the same thing (e.g. `big tits` + `big boobs`).
Aliases (docs: src/search/aliases.ts) are different: they rewrite words that are NOT tags.
Order of application on a parsed query: aliases first, then merges.

## Data
- A group is an ordered list of normalized keys, most popular first: `['big tits', 'big boobs']`.
  The first key is the group's canonical tag; the others redirect to it.
- `src/search/builtinMerges.ts`:
  `export const BUILTIN_MERGES: ReadonlyArray<ReadonlyArray<string>>` — each group ≥ 2 keys, ordered by
  RedGifs global count descending (verified), no key in two groups.
- User groups: localStorage `rgb:merges`, raw text, one group per line, members separated by commas
  (`big boobs, big tits`), `#` comments and blank lines ignored, keys normalized with normalizeTag.
  When saved from Settings, each line is reordered by global count (TagCounts / api.suggestTags exact
  entry) descending before storing, so the first member is the most popular; unknown counts sort last,
  ties keep the typed order.
- Combining: user groups override built-ins. Build the final groups so every key belongs to at most one
  group: if a user group shares any key with a built-in group, the built-in group is dropped entirely.
  A user line with a single key (`big boobs`) removes that key from any built-in group (un-merge); a
  built-in group left with < 2 keys is dropped.

## `src/search/merges.ts` (pure)
```ts
export interface MergeIndex {
  /** key → canonical key (identity for keys not in any group). */
  canonical(key: string): string;
  /** key → all keys of its group, canonical first ([key] when not merged). */
  members(key: string): string[];
}
export function buildMergeIndex(builtin: ReadonlyArray<ReadonlyArray<string>>, user: string[][]): MergeIndex;
export function parseMergeText(text: string): string[][];
/** Rewrites required / any / exact exclusions to canonical keys (dedupe). Partial exclusions untouched.
 *  applied = distinct { from, to } where from ≠ to. */
export function applyMerges(query: Query, index: MergeIndex): { query: Query; applied: { from: string; to: string }[] };
/** Exact blacklist rules expand to one rule per group member (keys recomputed, deduped). */
export function mergeBlacklist(rules: BlacklistRule[], index: MergeIndex): BlacklistRule[];
```

## Matching
`checkGif(gif, query, blacklist, nowSeconds, index?)` gains an optional MergeIndex (default: identity).
With it, a post's tag keys are mapped through `index.canonical` before every exact comparison
(required, any, exact exclusions, exact blacklist rules). Partial checks still use the raw keys.
Existing behaviour without the index is unchanged.

## Server streams (RedGifs filters on AND of exact-ish tags, so OR is done with several streams)
`src/search/server.ts` gains:
```ts
/** One `tags` list per stream: the cartesian product of the required tags' groups (members in
 *  popularity order, canonical spellings via `canonicalName(key)`), capped at `maxStreams` (4) by
 *  keeping combinations in product order (most popular first). No required tags → [undefined]. */
export function serverStreams(query: Query, index: MergeIndex, canonicalName: (key: string) => string, maxStreams?: number): (string[] | undefined)[];
```
`src/search/streams.ts`:
```ts
/** Combines several server streams into one FetchStreamPage for the PageFiller: combined page n =
 *  union of every stream's page n (streams already known to have ended are skipped), deduped by id,
 *  ordered: for order 'latest' by createDate desc, otherwise stream 0's items then stream 1's (each in
 *  their own order). pages = max of the streams' pages. A single stream is passed through unchanged. */
export function combineStreams(fetchers: FetchStreamPage[], order: ServerOrder): FetchStreamPage;
```

## UI
- PostsIndex: alias → merge pipeline on the parsed query; filler id/key, validation (validate the
  canonical keys; members of built-in groups were verified), streams, check (with index), sidebar and
  title all use the merged query. Note under the heading, merged with the alias note:
  "Searching big_tits (with big_boobs) for big_boobs." — keep it short and e621-like.
- Sidebar tags: aggregate by canonical key; names are shown with spaces (the key), links use the
  underscore term. Rows are the page's top 25 tags by page frequency. With no search, count = sum of
  members' global counts (any member unknown -> loading). With a search the count is an estimate
  ("~412k"): base (one required group: its global count; otherwise search totals x exact-match rate, or
  the smallest required group's global count when a stream hit RedGifs' 10000 cap) x share of the
  page's posts having the tag. There are no per-tag search requests.
- Settings: "Tag merges" section — textarea (one group per line, comma-separated), Save (reorders each
  line by popularity as above and shows the stored result), and a <details> list of built-in groups.
