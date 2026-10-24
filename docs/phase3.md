# Phase 3 contract — the post page (`/booru/posts/:id`)

Budget rule (user gets rate-limited easily): a post page costs at most ~3 API requests on a cold
cache and 0–1 when arriving from the posts grid. Everything goes through `api`/`tagCounts` (the
shared budget). Never call metrics/events endpoints; playing media never counts a view.

## Facts
- `GET /v2/gifs/:id?users=yes&niches=yes` → `{ gif, user, niches[] }`. gif fields used: id, userName,
  createDate (unix s), views (may be null), likes, duration (s, float), width, height, hasAudio,
  type (1 video, 2 image), tags[], niches[] (ids), description, verified, avgColor, gallery (may be
  null; ignore for now), urls { hd, sd, silent, poster, thumbnail }.
- Media URLs are plain and permanent: `https://media.redgifs.com/<Name>.mp4`, `-mobile.mp4`,
  `-silent.mp4`, `-poster.jpg`, `-mobile.jpg`. Use them directly in <video>/<img>; the page CSP
  does not restrict media-src/img-src.
- Creator posts: `GET /v2/users/:name/search?order=latest&count=N&page=1&type=g` → same shape as
  /v2/gifs/search (gifs, pages, total).
- Like rates (200 established posts, 2026-10-25): median 0.27 %, p10 0.06 %, p90 0.59 %.

## Score (replaces favoriteScore's formula; same function name and 0–100 integer output)
```
if views is not a finite number → null
p0 = 0.0025; m = 2000
smoothed = (max(0, likes) + m * p0) / (max(0, views) + m)
score = clamp(round(50 + 25 * log2(smoothed / p0)), 0, 100)
```
A brand-new post (0 views) scores 50. Update tests, the score tooltip text ("Score: favourites per
view vs. a typical post; 50 = typical, +25 = twice as many") and docs/phase2.md's Score section.

## Navigation context
Post links from the grid carry the search: `/booru/posts/:id?q=<route.tags>&page=<n>` (e621 style).
`src/router.ts`: the `post` route gains `q: string` and `page: number` (default '' / 1); hrefFor
emits them only when non-empty / > 1. "Use RedGifs' interface" stays `/watch/:id`.

`src/ui/fillers.ts` keeps the latest finished posts of each (fillerId, page):
`rememberPage(id, page, posts)`, `pagePosts(id, page): Gif[] | undefined`, and a lookup by post id
`findCached(gifId): Gif | undefined` across remembered pages (max ~20 pages kept, oldest dropped).
PostsIndex calls rememberPage when a fill is done.

A shared pure/hook layer (`src/ui/searchPipeline.ts`) computes, from a tags string, everything
PostsIndex derives today (parsed+aliased+merged query, rules, filler id, the PageFiller entry via
getFiller, fetch functions) so PostPage can reuse the exact same filler for ← →. Refactor
PostsIndex onto it without changing behaviour.

Neighbours (pure, tested): `neighbours(posts, id)` → `{ prev?: Gif, next?: Gif }` within a page.
At a page edge, PostPage asks the filler for page ± 1 (runFill; usually cached) and takes its last /
first post, navigating with page ± 1 in the URL.

## Tag categories
Categories: `creator`, `body`, `act`, `setting`, `meta`, `general` (default). The post's
`userName` is shown as the creator (not a tag).
- `src/search/builtinCategories.ts`: `BUILTIN_CATEGORIES: Readonly<Record<string, Category>>` for
  common RedGifs tags (normalized keys), compiled WITHOUT bulk API calls.
- User overrides: localStorage `rgb:tag-categories`, raw text, one `tag: category` per line
  (`#` comments). `src/store/categories.ts` (get/set/subscribe like aliases).
- `src/search/categories.ts`: `parseCategoryText`, `categoryOf(key, builtin, user)` (user wins;
  merge-canonical key used), `CATEGORY_ORDER = ['body','act','setting','general','meta']`,
  `CATEGORY_LABEL`, `CATEGORY_COLOR` (distinct, readable on the dark-red theme; creator amber
  `#f2ac08` like e621's artist).

## Page layout (e621 post page)
- Left sidebar: search box (prefilled with `q`), then tag groups by category in CATEGORY_ORDER with
  a header each ("Creator" first with the userName linking to `/booru/posts?tags=` — creator search
  arrives in phase 4, so for now link to `https://www.redgifs.com/users/<name>` in a new tab), each
  tag row `? + – name count` (names with spaces; + and – edit `q`; global counts via tagCounts,
  at most 8 uncached lookups per page view), then Information (ID, creator ✓ if verified, posted
  date relative + absolute, duration m:ss, size W×H, audio yes/no, views, favourites, score
  coloured, type), then Options (Open on RedGifs, Download HD, Download SD, Copy link), then
  Niches (links to `https://www.redgifs.com/niches/<id>` in a new tab).
- Main: the player, description below (if any), then "‹ Previous | Search: <q> | Next ›" bar,
  then related rows.
- Player: video → `<video controls loop autoplay playsInline poster=urls.poster src=urls.hd>`
  (fallback to sd on error); starts muted unless the user unmuted before (persist muted/volume in
  localStorage `rgb:player`); fits within the viewport height (max-height ~85vh), click on the
  image toggles original size. Image posts → `<img src=urls.hd>`.
- Keys: ←/a previous, →/d next (ignored while typing in an input/textarea or with modifiers).
- Download: `GM_download` (add `GM_download` to @grant) with a name like `<id>.mp4`; fallback: open
  the URL in a new tab.
- Related (loaded after the post, low priority, cached):
  1. "More from <creator>": creator posts endpoint, count 12, excluding this post (1 request).
  2. "Related": `/v2/gifs/search?tags=<2 most distinctive tags>&count=24&order=trending`, excluding
     this post, filtered to posts that carry both tags exactly. Distinctive = the post's tags
     (merge-canonical) with the lowest known global count ≥ 500; if counts are unknown, the first
     two tags (1 request).
  Rows of thumbnails reuse `Thumb` (links keep `q`).
- document.title: `<first 3 tags> – post <id> | RedGIFsbooru`.
