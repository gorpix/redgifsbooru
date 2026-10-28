# RedGIFsbooru

An e621-style booru front end for RedGifs, as a userscript. It replaces RedGifs' interface under `/booru` (for example https://www.redgifs.com/booru/posts) and leaves the rest of the site alone.

## Changelog

- **0.6.6**: "Show: any / straight / gay / trans" replaces the gender-tag filter.
- **0.6.5**: Content filters: hide untagged posts, and posts without a gender tag (via tag implications).
- **0.6.2**: RedGifs account: favourites (`fav:me`), follows, sets (collections), and a feed of followed creators.
- **0.5.2**: One-click install and automatic updates from GitHub releases.
- **0.5.1**: Post page display options (fit / fit width / fit height / original) in the sidebar.
- **0.5.0**: Tag wiki, creator pages, pools, popular. Post page with player, categorized tags and related posts. Aliases, merges, blacklist.

## Features

- Numbered pages of exact-tag search results.
- e621-style search syntax (see below).
- Tag sidebar sorted from most to least common, with counts (estimated within a search).
- Post page with player, categorized tags, and related posts.
- Tag wiki, creator pages, pools (RedGifs niches), and popular feeds.
- Tag aliases and merges, both built in and user-defined.
- Blacklist, with import from RedGIFS-X settings or your RedGifs blocked tags.
- Filters for untagged posts and posts without a gender tag.
- RedGifs account (log in on RedGifs once): favourites, follows, sets, and a feed of followed creators. The login token is never stored.
- Gentle on RedGifs' API: a request budget shared across tabs, and cached responses.

## Install

Install the Tampermonkey browser extension (tested in Firefox; other browsers and userscript managers are untested).

**[Install RedGIFsbooru](https://github.com/gorpix/redgifsbooru/releases/latest/download/redgifsbooru.user.js)**. Tampermonkey opens its install page; click Install. Updates arrive automatically from the latest release.

Then open https://www.redgifs.com/booru/posts.

Disable other RedGifs userscripts on `/booru` pages, or they may conflict with this one.

### Build from source

```
npm ci
npm run build
```

Install `dist/redgifsbooru.user.js` in Tampermonkey.

## Search syntax

| Token | Meaning |
|---|---|
| `tag`, `big_tits` | Required tag. Underscores join words. Quotes allow spaces: `"big tits"`. |
| `-tag` | Exclude posts with this exact tag. |
| `--part` | Exclude posts with any tag containing `part`. |
| `~a ~b` | At least one of the listed tags must match. |
| `views:>10k`, `favs:`, `score:` | Number filters. Operators: `>`, `>=`, `<`, `<=`, ranges `a..b`. |
| `age:<30d` | Age filter (`h`, `d`, `w`, `mo`, `y`). |
| `date:2026-01-01` | Calendar date filter. Also accepts `date:>2026-01-01`. |
| `order:latest`, `order:week`, `order:month` | Server-side order. `order:trending` is the default. |
| `order:views`, `order:score`, `order:oldest` | Sort within the current page only. |
| `type:image` | Images only. The default is videos (`type:video` or `type:gif`). |
| `fav:me` | Only your favourites (requires a RedGifs login). |

## Development

```
npm test              # unit tests (vitest)
npm run typecheck     # tsc --noEmit
npm run build         # typecheck, then build the userscript
```

Source layout:

- `src/api`: RedGifs client, request queue and budget, caching, tag counts.
- `src/search`: query parsing, matching, aliases and merges, page filling.
- `src/store`: localStorage-backed settings, blacklist, saved searches, and import.
- `src/ui`: Preact components for pages, grid, sidebar, and player.

Design notes live in `docs/` (`phase2.md` for the query language, `phase4.md` for routes and pages).

## Notes

- This is an unofficial project. It is not affiliated with RedGifs or e621.
- It uses RedGifs' private API, which may change without notice.
- Rate limits are per IP address, so keep one booru tab busy at a time.

## License

GPL-3.0-or-later. See `LICENSE`.
