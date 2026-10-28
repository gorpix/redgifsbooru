import type { ComponentChildren } from 'preact';
import { hrefFor, redgifsUrlFor, type Route } from '../router';
import { useAuthState } from './account';
import { accountIndicator, LOGIN_URL } from './accountHelpers';

interface Props {
  route: Route;
  children: ComponentChildren;
}

const wikiHref = hrefFor({ name: 'wikiIndex', q: '' });

/** Header account indicator: who is logged in, or how to log in. */
function AccountIndicator() {
  const { state, username } = useAuthState();
  const shown = accountIndicator(state, username);
  return (
    <span class="rgb-account">
      {shown.kind === 'user' && <a href={hrefFor({ name: 'favorites', tags: '', page: 1 })} title="Your RedGifs favorites">{shown.label}</a>}
      {shown.kind === 'login' && (
        <a href={LOGIN_URL} target="_blank" rel="noopener noreferrer" title="Opens RedGifs in a new tab; come back here afterwards">Log in on RedGifs</a>
      )}
      {shown.kind === 'problem' && <a class="error" href={hrefFor({ name: 'settings' })} title="See Settings → Account">Login problem</a>}
    </span>
  );
}

export function Layout({ route, children }: Props) {
  const postsHref = hrefFor({ name: 'posts', tags: '', page: 1 });
  const { state } = useAuthState();
  const loggedIn = state === 'loggedIn';

  return (
    <div class="rgb-page">
      <header class="rgb-header">
        <a class="rgb-site" href={postsHref}>RedGIFsbooru</a>
        <AccountIndicator />
      </header>
      <nav class="rgb-nav">
        <a href={postsHref} class={route.name === 'posts' || route.name === 'post' ? 'active' : ''}>Posts</a>
        <a href={hrefFor({ name: 'popular', scale: 'day' })} class={route.name === 'popular' ? 'active' : ''}>Popular</a>
        <a href={wikiHref}>Tags</a>
        <a href={hrefFor({ name: 'pools', page: 1 })} class={route.name === 'pools' || route.name === 'pool' ? 'active' : ''}>Pools</a>
        <a href={hrefFor({ name: 'sets' })} class={route.name === 'sets' || route.name === 'set' ? 'active' : ''}>Sets</a>
        {loggedIn && <a href={hrefFor({ name: 'favorites', tags: '', page: 1 })} class={route.name === 'favorites' ? 'active' : ''}>Favorites</a>}
        {loggedIn && <a href={hrefFor({ name: 'feed', tags: '', page: 1 })} class={route.name === 'feed' ? 'active' : ''}>Feed</a>}
        <a href={wikiHref} class={route.name === 'wiki' || route.name === 'wikiIndex' ? 'active' : ''}>Wiki</a>
        <a href={hrefFor({ name: 'settings' })} class={route.name === 'settings' ? 'active' : ''}>Settings</a>
      </nav>
      <nav class="rgb-subnav">
        <a href={postsHref}>Listing</a>
        {loggedIn && <a href={hrefFor({ name: 'following', page: 1 })} class={route.name === 'following' ? 'active' : ''}>Following</a>}
        <span class="soon" title="Coming later">Hot</span>
        <span class="rgb-spacer" />
        <a class="rgb-redgifs" href={redgifsUrlFor(route)}>Use RedGifs' interface</a>
      </nav>
      {children}
    </div>
  );
}
