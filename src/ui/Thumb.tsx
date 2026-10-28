import type { ComponentChildren } from 'preact';
import type { Gif } from '../api/types';
import { favoriteScore } from '../search/match';
import { hrefFor, type PostSrc } from '../router';
import { useAccount, useAccountToggle } from './account';
import { LOGIN_URL } from './accountHelpers';
import { formatCount, formatDuration, tagToken } from './format';

export function scoreColor(score: number): string {
  return `hsl(${Math.round((score / 100) * 120)} 82% 56%)`;
}

interface ThumbProps {
  gif: Gif;
  /** Search the thumb was shown for; carried in the post link (`?q=`). */
  q?: string;
  /** Grid page the thumb was shown on; carried in the post link (`?page=`) when > 1. */
  page?: number;
  /** Stream the grid came from (creator / pool); carried in the post link (`?src=`). */
  src?: PostSrc;
  /** Extra control under the stats (e.g. "remove" in a set's edit mode). */
  action?: ComponentChildren;
}

/** The ♥ overlay: hover to show, always visible when liked. Needs the account context. */
function FavoriteHeart({ id }: { id: string }) {
  const account = useAccount();
  const fav = useAccountToggle(account?.likes ?? null, id, 'favorite');
  if (!account) return null;
  return (
    <>
      <button
        type="button"
        class={`thumb-fav${fav.on ? ' on' : ''}`}
        aria-pressed={fav.on}
        title={fav.on ? 'Remove from your RedGifs favorites' : 'Add to your RedGifs favorites'}
        onClick={() => { void fav.toggle(); }}
      >
        {fav.on ? '♥' : '♡'}
      </button>
      {fav.note && (
        <span class={`thumb-note ${fav.note.kind}`} role="status">
          {fav.note.kind === 'login'
            ? <a href={LOGIN_URL} target="_blank" rel="noopener noreferrer">{fav.note.text}</a>
            : fav.note.text}
        </span>
      )}
    </>
  );
}

export function Thumb({ gif, q = '', page = 1, src: postSrc = '', action }: ThumbProps) {
  const tags = gif.tags.map(tagToken).join(' ');
  const date = new Date(gif.createDate * 1000).toISOString().slice(0, 10);
  const title = `${tags}\nby ${gif.userName} on ${date}`;
  const src = gif.urls.thumbnail ?? gif.urls.poster;
  const score = favoriteScore(gif);
  return (
    <article class="thumb">
      <a href={hrefFor({ name: 'post', id: gif.id, q, page, src: postSrc })} style={gif.avgColor ? { background: gif.avgColor } : undefined}>
        {src && <img src={src} loading="lazy" alt={tags} title={title} />}
      </a>
      <FavoriteHeart id={gif.id} />
      <div class="thumb-stats">
        <span class="score" title="Score: favourites per view vs. a typical post; 50 = typical, +25 = twice as many" style={score === null ? undefined : { color: scoreColor(score) }}>
          {score === null ? '–' : `↑${score}`}
        </span>
        <span title="Likes">♥ {formatCount(gif.likes)}</span>
        <span title="Views">▶ {formatCount(gif.views)}</span>
        {gif.type === 2 ? <span title="Image">img</span> : <span title="Duration">{formatDuration(gif.duration)}</span>}
      </div>
      {action}
    </article>
  );
}
