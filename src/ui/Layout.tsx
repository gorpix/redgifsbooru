import type { ComponentChildren } from 'preact';
import { hrefFor, redgifsUrlFor, type Route } from '../router';

interface Props {
  route: Route;
  children: ComponentChildren;
}

const wikiHref = hrefFor({ name: 'wikiIndex', q: '' });

export function Layout({ route, children }: Props) {
  const postsHref = hrefFor({ name: 'posts', tags: '', page: 1 });

  return (
    <div class="rgb-page">
      <header class="rgb-header">
        <a class="rgb-site" href={postsHref}>RedGIFsbooru</a>
      </header>
      <nav class="rgb-nav">
        <a href={postsHref} class={route.name === 'posts' || route.name === 'post' ? 'active' : ''}>Posts</a>
        <a href={hrefFor({ name: 'popular', scale: 'day' })} class={route.name === 'popular' ? 'active' : ''}>Popular</a>
        <a href={wikiHref}>Tags</a>
        <a href={hrefFor({ name: 'pools', page: 1 })} class={route.name === 'pools' || route.name === 'pool' ? 'active' : ''}>Pools</a>
        <span class="soon" title="Coming later">Sets</span>
        <a href={wikiHref} class={route.name === 'wiki' || route.name === 'wikiIndex' ? 'active' : ''}>Wiki</a>
        <a href={hrefFor({ name: 'settings' })} class={route.name === 'settings' ? 'active' : ''}>Settings</a>
      </nav>
      <nav class="rgb-subnav">
        <a href={postsHref}>Listing</a>
        <span class="soon" title="Coming later">Hot</span>
        <span class="rgb-spacer" />
        <a class="rgb-redgifs" href={redgifsUrlFor(route)}>Use RedGifs' interface</a>
      </nav>
      {children}
    </div>
  );
}
