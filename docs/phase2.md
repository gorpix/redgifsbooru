# Phase 2 contract — search, page filler, tags, blacklist, import

This file is the agreement between the modules built in parallel. Follow the
names and shapes exactly; if something here is impossible, say so in your
report rather than changing the interface silently.

Shared helper (already written, do not change): `src/search/tags.ts`
- `normalizeTag(v)` → comparison key (`"Big_Tits "` → `"big tits"`)
- `toTagTerm(v)` → typed/display form (`"Big Tits"` → `"big_tits"`)

Gif shape: `src/api/types.ts` (`Gif`: id, userName, createDate unix s, views|null, likes, tags[], type 1 video / 2 image, urls…).

## Query language (port of RedGIFS-X, plus booru additions)

Tokens are whitespace-separated, matched with
`/(--|-|~)?(?:"([^"]+)"|([^\s"]+))/g` (optional prefix, then a quoted string or a bare run).

| Token | Meaning |
|---|---|
| `tag`, `big_tits`, `"big tits"` | required tag, exact (normalizeTag equality) |
| `-tag` | exclude: hide posts having this exact tag |
| `--part` | partial exclude: hide posts having any tag whose key contains `part` |
| `~a ~b` | one OR-group: post needs at least one of them (exact) |
| `views:`, `favs:` (aliases `favorites:`, `likes:` → favs), `score:`, `age:`, `date:` | meta filters, see below; only bare tokens with no prefix |
| `order:X` | see Orders; only bare tokens; unknown X falls through to a plain tag |
| `type:video` / `type:gif` / `type:g` → `'g'`; `type:image` / `type:images` / `type:i` → `'i'` | media type (booru addition); default `'g'`; last wins; unknown value falls through to a plain tag |

Unknown or invalid `field:value` tokens fall through and become plain required tags
(e.g. `views:abc` → required tag `views:abc`); tag validation then reports them.
Lists are de-duplicated. Empty values after normalization are skipped.

### Meta filters
Pattern `/^(views|favs|favorites|likes|score|date|age):(.+)$/i`.
- Numbers (views, favs, score): `/^(\d+(?:\.\d+)?)([km]?)$/i`, k = 1e3, m = 1e6.
- Age: `/^(\d+(?:\.\d+)?)(h|d|w|mo|y)$/i` → seconds (h 3600, d 86400, w 604800, mo 2592000, y 31536000).
- Date: `YYYY-MM-DD` → LOCAL midnight in unix seconds. Only valid for the `date` field.
  `date:` with an age value (e.g. `date:7d`) is an age filter. `age:` with a calendar date is invalid.
- Grammar: `op? value` with op in `> >= < <=` (default `=`), or a range `a..b` (either side may be
  empty = open; both ends inclusive; no operator allowed with a range). An invalid side → invalid.
- Represent every filter as a range on the compared value:
  `{ field, kind: 'number'|'age'|'date', min, max, minInclusive, maxInclusive, label }`
  where `label` = `${fieldAsTypedLowercase}:${rawValueLowercase}` (used for display and round-trip).
  - number `=` → [v, v]; `>v` → (v, ∞); `>=v` → [v, ∞); `<v` → (-∞, v); `<=v` → (-∞, v]
  - age (compared value = now − createDate, in seconds): `=v` means "within v" → [0, v];
    operators as for numbers; so `age:<30d` = newer than 30 days.
  - date (compared value = createDate): `=d` → [d, d+86400); operators compare against d
    (`date:>2026-01-01` → (d, ∞)); range `a..b` → [a, b].
- Compared values: views → `gif.views`, favs → `gif.likes`, score → `favoriteScore(gif)`,
  age/date → `gif.createDate` (if > 1e12 treat as ms and divide by 1000).
- A null / non-finite compared value PASSES the filter.

### Score
```
null if views or likes is not a finite number
p0 = 0.0025; m = 2000
smoothed = (max(0, likes) + m * p0) / (max(0, views) + m)
score = clamp(round(50 + 25 * log2(smoothed / p0)), 0, 100)   // integer 0..100
```
50 = a typical post (median like rate 0.27 %), +25 = twice as many favourites per view. A post with
0 views scores 50 (smoothing toward the typical rate). Changed in phase 3.

### Orders
Server orders (global, the order the stream is scanned in). Default `trending`.
- `trending`
- `latest` ← aliases `latest`, `new`, `newest`, `date`, `recent`
- `top7` ← `top7`, `week`
- `top28` ← `top28`, `month`

Page sorts (RedGIFS-X orders; RedGifs cannot sort a tag search by these, so they only
reorder the posts within each booru page; stable; null/unknown values last in both directions):
- `views-desc` ← `views`, `views_desc`; `views-asc` ← `views_asc`
- `score-desc` ← `score`, `score_desc`; `score-asc` ← `score_asc`
- `favs-desc` ← `favs`, `favs_desc`, `likes`; `favs-asc` ← `favs_asc`
- `date-asc` ← `date_asc`, `old`, `oldest`

A query may hold one server order and one page sort (last token of each kind wins).
Order aliases are case-insensitive.

## Module interfaces

### `src/search/query.ts`
```ts
export type ServerOrder = 'trending' | 'latest' | 'top7' | 'top28';
export type PageSort = 'views-desc' | 'views-asc' | 'score-desc' | 'score-asc' | 'favs-desc' | 'favs-asc' | 'date-asc';
export type MediaType = 'g' | 'i';
export interface Exclusion { mode: 'exact' | 'partial'; value: string }   // value = normalized key
export type MetaField = 'views' | 'favs' | 'score' | 'age' | 'date';
export interface MetaFilter {
  field: MetaField; kind: 'number' | 'age' | 'date';
  min: number; max: number; minInclusive: boolean; maxInclusive: boolean;
  label: string;
}
export interface Query {
  required: string[];          // normalized keys
  any: string[];               // normalized keys (the ~ group)
  exclusions: Exclusion[];
  meta: MetaFilter[];
  serverOrder: ServerOrder;
  pageSort: PageSort | null;
  type: MediaType;
}
export function parseQuery(text: string): Query;
/** Canonical text: required terms, excludes (-a / --a), ~any, meta labels,
 *  `type:image` if 'i', `order:<server>` if not trending, `order:<first alias of page sort>`. Terms use toTagTerm; terms containing a quote are not expected. */
export function formatQuery(query: Query): string;
/** Stable cache key: like formatQuery but every list sorted. */
export function queryKey(query: Query): string;
export function parseMetaFilter(token: string): MetaFilter | null;
```

### `src/search/match.ts`
```ts
export interface BlacklistRule { mode: 'exact' | 'partial'; value: string; key: string } // key = `${mode}:${value}`
/** RedGIFS-X blacklist text: entries split on /[,\n]+/, trimmed; leading `*` → partial;
 *  a leading `-` is stripped (still exact); surrounding quotes stripped; value normalized;
 *  dedupe by key; empty entries skipped. */
export function parseBlacklist(text: string): BlacklistRule[];
export function favoriteScore(gif: Pick<Gif, 'likes' | 'views'>): number | null;
/** Why a post is rejected, or null when it matches. Order of checks: blacklist (rules passed
 *  in are already the active ones), exclusions, required, any-group, meta. */
export type Rejection = 'blacklist' | 'exclude' | 'required' | 'any' | 'meta';
export function checkGif(gif: Gif, query: Query, blacklist: BlacklistRule[], nowSeconds: number): Rejection | null;
/** Stable sort for page sorts; null/unknown values after known ones in both directions. */
export function sortPage(gifs: Gif[], sort: PageSort): Gif[];
```

### `src/search/server.ts`
```ts
/** API params for the stream to scan. `canonical` maps normalized required keys to RedGifs'
 *  spelling (from /v1/tags/match); missing entries fall back to the key itself.
 *  tags = the required tags (canonical) when there are any; otherwise undefined (the ~group
 *  and filters are then applied client-side to the unfiltered stream). */
export function serverParams(query: Query, canonical?: Map<string, string>):
  { order: ServerOrder; type: MediaType; tags?: string[] };
```

### `src/search/filler.ts`
Numbered booru pages filled from RedGifs' server pages (count=100).
```ts
export interface StreamPage { gifs: Gif[]; pages: number }   // pages = server page count
export type FetchStreamPage = (serverPage: number, signal: AbortSignal) => Promise<StreamPage>;
/** null = keep; otherwise a reason string, tallied in FillState.rejected. */
export type Check = (gif: Gif) => string | null;
export interface Cursor { serverPage: number; index: number } // next unread item
export interface FillState {
  page: number;                    // booru page being filled (1-based)
  posts: Gif[];                    // matches for `page`, in stream order (≤ pageSize)
  pageSize: number;
  phase: 'seeking' | 'filling' | 'done' | 'paused' | 'error';
  seekingPage?: number;            // while filling earlier pages to find where `page` starts
  serverPagesScanned: number;      // during this fill() call
  rejected: Record<string, number>;// tallies for posts scanned for `page`
  endReached: boolean;             // the stream ran out
  lastPage: number | null;         // known final booru page once endReached, else null
  knownPages: number;              // pages whose start is known (≥ page when done)
  error?: unknown;
}
export interface FillerOptions {
  key: string;                     // queryKey + blacklist state; identifies the stream
  fetchPage: FetchStreamPage;
  check: Check;
  pageSize?: number;               // default 75
  maxServerPagesPerRun?: number;   // default 20; then phase 'paused' (UI offers "Keep scanning")
  maxServerPage?: number;          // default 100 (RedGifs caps results at 10,000)
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null; // sessionStorage; persists page starts
  now?: () => number;              // ms; cursor records expire after 30 min
}
export class PageFiller {
  constructor(options: FillerOptions);
  /** Fills `page`, reporting progress via onUpdate (each server page at least). Resumes a
   *  paused fill when called again for the same page. Rejects with AbortError when aborted. */
  fill(page: number, onUpdate: (state: FillState) => void, signal?: AbortSignal): Promise<FillState>;
}
```
Rules: page 1 starts at {serverPage 1, index 0}; page n starts where page n−1's 75th match
ended (cursor after it). To fill page n with unknown start, fill pages before it first
(phase 'seeking', seekingPage set). Dedupe gifs by id across the whole stream. End of stream
= empty `gifs`, or serverPage > pages, or serverPage > maxServerPage. Fetch one server page at
a time. Persist page starts + end info in storage under `rgb:cursor:<key>` as
`{ at: ms, starts: Cursor[], lastPage: number | null }`; ignore records older than 30 min.

### `src/api/` additions
- `RequestQueue.run(task, { priority?: 'high' | 'low', signal?: AbortSignal })`: low tasks start
  only when no high task is waiting; a task whose signal is aborted before it starts is dropped
  and its promise rejects with `new DOMException('Aborted', 'AbortError')`.
- `RedgifsApi.getJson(path, params, { ttlMs, priority, signal })`; an aborted request is removed
  from in-flight de-duplication so later callers start fresh. `searchGifs(params, { signal, priority })`.
- `RedgifsApi.matchTag(name): Promise<string | null>` — GET `/v1/tags/match?query=<normalized key>`;
  returns RedGifs' spelling whose normalizeTag equals the key, else null. TTL 1 day.
- `RedgifsApi.suggestTags(fragment): Promise<{ text: string; count: number }[]>` — GET
  `/v2/search/suggest?query=`; keep `type === 'tag'` entries with string `text`; count = `Number(gifs) || 0`. TTL 1 day.
- `src/api/tagCounts.ts`: `class TagCounts` — global counts with persistent localStorage cache
  `rgb:tag-counts` in RedGIFS-X's format `{ "<key>": [count | null, savedAtMs, [similar…]] }`,
  max age 3 days, max 5000 entries (newest kept), debounced save. Looks up via suggestTags at
  LOW priority: count = gifs of the entry whose normalizeTag equals the key, null if none;
  similar = first 4 suggestion texts. API: `get(name): number | null | undefined`
  (undefined = unknown/loading), `similar(name): string[]`, `request(names: string[]): void`,
  `subscribe(listener: () => void): () => void`, `merge(entries)` (used by import; newer wins).
  Failed lookups are retried after 5 min, not persisted.

### `src/store/`
All localStorage access wrapped in try/catch; every read tolerates garbage.
- `settings.ts`: `{ postsPerPage: 75, blacklistEnabled: true, dimSeen: true }` at `rgb:settings`; `getSettings()`, `updateSettings(patch)`, `subscribeSettings(fn)`.
- `blacklist.ts`: raw text at `rgb:blacklist` (RedGIFS-X format), paused rule keys at `rgb:blacklist-paused` (JSON array); `getBlacklistText()`, `setBlacklistText(text)`, `getPausedKeys()`, `setPausedKeys(keys)`, `subscribeBlacklist(fn)`.
- `saved.ts`: `[{ name, query }]` at `rgb:saved-searches`; `getSavedSearches()`, `saveSearch(name, query)` (dedupe by query, replace and move to end), `removeSavedSearch(query)`.
- `seen.ts`: lowercase ids at `rgb:seen`, newest 5000 kept, merge with storage before each write; `isSeen(id)`, `markSeen(id)`.
- `importRedgifsX.ts`: reads RedGIFS-X's keys from the same localStorage (same origin):
  `rg-view-sort:tag-blacklist-v1` (raw text), `rg-view-sort:blacklist-disabled-v1` (JSON keys),
  `rg-view-sort:saved-searches-v1` (`[{name,url}]`), `rg-view-sort:seen-v1` (ids),
  `rg-view-sort:dim-seen-v1` (bool), `rg-view-sort:tag-counts-v1` (same format as ours).
  `detectRedgifsX(storage)` → counts of what is there; `importRedgifsX(storage, tagCounts)` →
  merges (blacklist: append entries not already present; paused keys union; saved searches
  converted; seen union; dim-seen copied; tag counts merged newer-wins) and returns counts.
  Saved-search URL → booru query: from its search params, `rg-tag` → term, `rg-exclude` → `-term`,
  `rg-exclude-contains` → `--term`, `rg-any` → `~term`, `rg-filter` → as-is, `rg-order` → `order:x`;
  with no `rg-tag` but a `query` param, the query text is one tag. URLs under `/users/` or with
  nothing convertible are skipped and counted.
