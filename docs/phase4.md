# Phase 4 contract — wiki, creators, pools, popular

Budget rule as before: few requests per page view, everything through `api`/`tagCounts`, low
priority for anything decorative, responses cached via getJson TTL.

## Endpoints (verified 2026-10-25)
- `GET /v2/tags/{Name}` (RedGifs spelling, from matchTag) → `{ tag, description: string | null, related: string[] (≈50 names) }`.
- `GET /v1/users/{name}` → profile `{ username/name, description, followers, following, gifs, publishedGifs, profileImageUrl, profileUrl, creationtime (unix s), verified?, socialUrl1..3, … }` (read defensively).
- `GET /v2/users/{name}/search?order&type&count&page&tags=A,B` → SearchPage shape (tags param works; total = that creator's matches). `api.userGifs` exists.
- `GET /v2/niches?count=N&page=P` → `{ page, pages, total (≈1836), niches: [{ id, name, gifs, subscribers, tags, thumbnail, preferences }] }`.
- `GET /v2/niches/{id}` → `{ niche: { id, name, description, cover, thumbnail, gifs, subscribers, owner, rules, tags } }`.
- `GET /v2/niches/{id}/gifs?order&count&page` → SearchPage shape (ignore boosted_gifs/promoted_gifs); total NOT capped (e.g. 138k); no tags param.

## Display rules
- Niche names: `formatNicheName(id)` → hyphens to spaces, first letter upper-case, rest as given
  (`pale-girls` → `Pale girls`). Use it everywhere a niche is shown (post page Niches too).
- Tag names in lists use spaces; queries/links use toTagTerm (unchanged rule).

## Routes (src/router.ts)
- `/booru/wiki` → `{ name: 'wikiIndex', q }` (a search box: typing a tag opens its wiki page)
- `/booru/wiki/:term` → `{ name: 'wiki', tag: normalized key }`
- `/booru/users/:name` + `?tags=&page=` → `{ name: 'user', user, tags, page }`
- `/booru/pools` + `?page=` → `{ name: 'pools', page }`
- `/booru/pools/:id` + `?tags=&page=` → `{ name: 'pool', id, tags, page }`
- `/booru/popular` + `?scale=day|week|month` → `{ name: 'popular', scale }` (day → trending, week → top7, month → top28)
hrefFor and redgifsUrlFor for each (`/users/<name>`, `/niches/<id>`, `/` …). Nav: Popular, Tags → /booru/wiki,
Pools → /booru/pools, Wiki → /booru/wiki become real links (Sets stays dim, phase 5).

## Streams
`src/ui/searchPipeline.ts` gains a source: `{ kind: 'search' } | { kind: 'user', name } | { kind: 'niche', id }`.
The filler id includes the source. user → `api.userGifs(name, { tags, order, type, count: 100, page })`
(order default 'latest'); niche → `api.nicheGifs(id, { order, count: 100, page })` (no server tags:
filters apply client-side; default order 'trending' if accepted, else 'latest' — try both once and keep
what works); search → unchanged. Exact filtering, aliases, merges, blacklist, page sorts all apply as in
the posts index. Reuse PostsIndex's grid/progress/paginator by extracting a `PostGrid` component.

## Pages
- Wiki `/booru/wiki/:term`: heading (tag with spaces, coloured by category), global count, category
  (with a small select that writes a user override via the categories store), aliases that point to it
  and its merge group, RedGifs' description or "No description on RedGifs.", related tags (from
  /v2/tags; spaces; each links to its wiki; show global counts only if already cached — no lookups),
  then "Posts" strip: up to 12 posts carrying the tag exactly (one searchGifs count 24) and
  "View all posts". Unknown tag → "No tag named …" + did-you-mean (reuse).
- Creator `/booru/users/:name`: profile box (avatar, name, ✓, bio, followers, posts, joined, social
  links), search box scoped to this creator (query language as usual), grid + paginator.
- Pools index `/booru/pools`: e621 pools table (thumbnail, name via formatNicheName, posts, subscribers),
  50 per page, numbered pages from `pages`.
- Pool `/booru/pools/:id`: header (name, description, rules collapsed, subscribers, post count, tags as
  links), scoped search box, grid + paginator.
- Popular `/booru/popular`: tabs Day / Week / Month, then the grid for that server order with no tags.

## Links from existing pages
- Sidebar tag rows' `?` → `/booru/wiki/<term>` (posts sidebar AND post page).
- Post page Creator → `/booru/users/<name>`; "More from <creator>" heading links there too.
- Post page Niches → `/booru/pools/<id>` with formatNicheName.
