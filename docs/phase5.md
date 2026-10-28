# Phase 5 contract — account (favourites, follows, sets)

Findings: spike 2026-10-28 + RedGifs bundle read. Never log, display or persist token VALUES
(debug logs show lengths/flags only). Never call Kinde logout. Never touch the user's password.

## Login (src/api/auth.ts)
- Kinde: client_id `e06c34dac7654821bcb37e0393b54350`, token endpoint `https://auth2.redgifs.com/oauth2/token`.
- Refresh request (must run in the PAGE world on www.redgifs.com so the httpOnly refresh cookie
  and the right Origin are used): `fetch(endpoint, { method: 'POST', credentials: 'include',
  headers: { 'Content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Kinde-SDK':
  'JavaScript/redgifsbooru' }, body: 'client_id=<id>&grant_type=refresh_token' })`.
  200 → `{ id_token, access_token, refresh_token, expires_in, … }`; 400 → logged out.
- RedGifs' API authorizes the **id_token** (`Authorization: Bearer <id_token>`; lifetime 60 min).
  The access_token is rejected (401).
- Run it from the userscript by injecting an inline `<script>` (page CSP allows 'unsafe-inline')
  that performs the fetch and hands back the result via a `CustomEvent` on `document` with a random
  per-call event name; the token travels only in that event's detail (string), not in the DOM.
- takeover.ts PAGE_CSP: `connect-src https://auth2.redgifs.com` (instead of 'none'); everything else
  unchanged.
- `AuthManager`: state `'unknown' | 'loggedIn' | 'loggedOut' | 'error'` + `username` (from `/v1/me`)
  + subscribe. `getToken()` → id_token if logged in and not expiring within 5 min, else refresh.
  Logged out → callers fall back to the guest token.
  - Cross-tab: only one tab refreshes at a time. Lock `rgb:auth-lock` in localStorage (`{owner, until}`,
    15 s lease); share the fresh id_token + expiry with other booru tabs over `BroadcastChannel('rgb-auth')`
    (in memory only; a new tab first asks peers `{type:'need'}` and waits 500 ms before refreshing).
    Never write the token to localStorage/sessionStorage/IndexedDB.
  - Keep-alive (setting `keepLoggedIn`, default true): while any booru tab is visible or open, refresh
    when the id_token has < 10 min left (≈ every 50 min), only in the tab holding the lock.
  - 401 from the API while logged in → force one refresh and retry once; still 401 → mark 'error'
    (do NOT log out).
- RedgifsApi uses the auth manager as its token provider (user token when logged in, guest token
  otherwise). Cached GET responses must be keyed so a logged-in user's personalized responses
  (`/v2/me/*`, `/v1/me*`, `/v2/likes`, `/v2/feeds/liked`) are NEVER cached in IndexedDB (memory
  cache ≤ 60 s at most), and guest/public responses stay as now.

## Transport
Extend the transport to `{ method, url, headers, body?, timeoutMs }` (GET/PUT/POST/PATCH/DELETE,
JSON bodies with `Content-Type: application/json`). Writes: never cached, never deduped, HIGH
priority, count against the budget; they invalidate related cache entries (likes list, liked feed,
follows, collections and that collection's gifs).

## Account endpoints (base https://api.redgifs.com)
- `GET v1/me` → `{ username, name, description, profileUrl, profileImageUrl, blockedTags: string[], preferences }`.
- Likes: `GET v2/likes` → `string[]` (all liked gif ids). Like: `PUT v2/gifs/{id}/like` body
  `{ context: 'booru', source: 'booru', source_id: null, position: 0 }`. Unlike: `DELETE v2/gifs/{id}/like`
  body `{ context: 'booru' }`.
- Liked feed: `GET v2/feeds/liked?page=&count=30&type=g|i` → feed shape (expect `gifs`, `page`, `pages`,
  `total`; read defensively).
- Follows: `GET v1/me/follows` → `string[]` usernames. Follow `PUT v1/me/follows/{username}` body
  `{ source: 'booru', source_id: null, position: 1 }`; unfollow `DELETE v1/me/follows/{username}` (no body).
  Following list: `GET v2/me/following?count=100&page=` → `{ items: profile[], page, pages, total }`.
- Collections (= sets): list `GET v2/me/collections?count=50&page=` → `{ collections: [{ folderId,
  folderName, published, description, thumbs, … }], pages, totalCount }`; one `GET v2/me/collections/{id}`;
  gifs `GET v2/me/collections/{id}/gifs?count=100&page=` (feed shape); create `POST v2/me/collections`
  `{ folderName, description: string | null, published: boolean }` → new collection; update
  `PATCH v2/me/collections/{id}` `{ collectionId, folderName, description, published }`; delete
  `DELETE v2/me/collections/{id}`; add `POST v2/me/collections/{id}/gifs` `{ gifId, context: 'booru' }`
  (one per call); remove `DELETE v2/me/collections/{id}/gifs` body = JSON array of gif ids.
  No "collections containing gif" endpoint: track membership locally per session.
- Blocked tags: `v1/me.blockedTags` (read only for us; offer "Import into blacklist").

## Stores (src/store/account.ts)
- Likes: Set of ids loaded once per session (and after login), optimistic like/unlike with revert on
  error, subscribe. Follows: same with usernames.

## UI (second step)
- Header: account indicator — username (link to /booru/favorites) or "Log in on RedGifs" (opens
  `https://www.redgifs.com/login` in a new tab; the booru picks the login up on the next refresh / focus).
- Favourite ♥ toggle on thumbnails (hover) and in the post page Options; liked thumbnails show ♥ filled.
- Search token `fav:me` (posts index) → source `{ kind: 'liked', type }` streaming v2/feeds/liked pages
  through the same filler (other tokens filter client-side). `/booru/favorites` = grid of `fav:me`.
- Follow / Unfollow on creator pages and the post page creator row; `/booru/following` lists followed
  creators (avatar, name, posts) linking to their creator pages.
- Sets: nav "Sets" → `/booru/sets` (my collections table: name, posts, public/private; create, rename,
  edit description, toggle public, delete with confirm), `/booru/sets/:id` (grid via source
  `{ kind: 'set', id }`; per-thumb "remove from set" in an edit mode), post page Options "Add to set…"
  (list of my sets, add; remembers per-session membership to show ✓).
- Settings → Account: status, username, "Refresh login now", "Keep me logged in" (keepLoggedIn),
  "Import RedGifs blocked tags into the blacklist".
