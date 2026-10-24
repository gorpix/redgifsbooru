import { useEffect } from 'preact/hooks';
import type { RedgifsApi } from '../api/client';
import type { TagCounts } from '../api/tagCounts';
import type { UserProfile } from '../api/types';
import { hrefFor, type Route, type Router } from '../router';
import { safeLink } from './browseHelpers';
import { Columns } from './Columns';
import { formatCount } from './format';
import { PostGrid, usePostGrid } from './PostGrid';
import { errorMessage } from './postsHelpers';
import { SearchBox } from './SearchBox';
import { ScopedSidebar } from './ScopedSidebar';
import { useSearchPipeline } from './searchPipeline';
import { useLoad } from './useLoad';

const SITE = 'RedGIFsbooru';

interface Props {
  api: RedgifsApi;
  router: Router;
  tagCounts: TagCounts;
  route: Extract<Route, { name: 'user' }>;
}

function ProfileBox({ profile, fallbackName }: { profile: UserProfile | null; fallbackName: string }) {
  if (!profile) return <p class="muted">No creator named {fallbackName} on RedGifs.</p>;
  const links = profile.socials.map((url) => ({ url, href: safeLink(url) })).filter((l): l is { url: string; href: string } => l.href !== null);
  return (
    <div class="rgb-profile">
      {profile.profileImageUrl && <img class="rgb-avatar" src={profile.profileImageUrl} alt="" />}
      <div class="rgb-profile-body">
        <p class="rgb-profile-name">
          {profile.username}
          {profile.verified && <span class="rgb-verified" title="Verified creator"> ✓</span>}
        </p>
        {profile.description && <p class="rgb-profile-bio">{profile.description}</p>}
        <p class="muted rgb-profile-stats">
          <span title="Followers">{formatCount(profile.followers)} followers</span>
          {' · '}
          <span title="Posts">{formatCount(profile.posts)} posts</span>
          {profile.createdAt !== null && <> · joined {new Date(profile.createdAt * 1000).toISOString().slice(0, 10)}</>}
        </p>
        {links.length > 0 && (
          <p class="rgb-profile-links">
            {links.map((l, i) => (
              <span key={l.href}>
                {i > 0 && ' · '}
                <a href={l.href} target="_blank" rel="noopener noreferrer nofollow">{l.url.replace(/^https?:\/\/(www\.)?/, '')}</a>
              </span>
            ))}
          </p>
        )}
      </div>
    </div>
  );
}

export function CreatorPage({ api, router, tagCounts, route }: Props) {
  const name = route.user;
  const pipeline = useSearchPipeline(route.tags, { api, source: { kind: 'user', name } });
  const grid = usePostGrid(pipeline, route.page);
  const profile = useLoad(`user:${name.toLowerCase()}`, (signal) => api.userProfile(name, { signal }));

  const shownName = profile.status === 'ok' && profile.value ? profile.value.username : name;
  useEffect(() => {
    const suffix = route.page > 1 ? ` – page ${route.page}` : '';
    document.title = `${shownName}${pipeline.queryText ? `: ${pipeline.queryText}` : ''} | ${SITE}${suffix}`;
  }, [shownName, pipeline.queryText, route.page]);

  const linkTo = (tags: string, page: number) => hrefFor({ name: 'user', user: name, tags, page });
  const searchBox = (
    <SearchBox
      key={`${name}|${route.tags}`}
      api={api}
      router={router}
      tagCounts={tagCounts}
      initial={route.tags}
      placeholder={`Search ${shownName}`}
      submitHref={(text) => linkTo(text, 1)}
    />
  );

  return (
    <Columns
      api={api}
      router={router}
      tagCounts={tagCounts}
      route={route}
      searchBox={searchBox}
      searchTitle="Search creator"
      sidebar={<ScopedSidebar grid={grid} tagCounts={tagCounts} searchHref={(tags) => linkTo(tags, 1)} />}
    >
      <h1 class="rgb-title">Creator: {shownName}</h1>
      {profile.status === 'loading' && <p class="rgb-progress">Loading profile…</p>}
      {profile.status === 'error' && (
        <div class="rgb-notice error">
          <p>{errorMessage(profile.error)}</p>
          <button type="button" onClick={profile.retry}>Retry</button>
        </div>
      )}
      {profile.status === 'ok' && <ProfileBox profile={profile.value} fallbackName={name} />}
      <h2 class="rgb-section">{pipeline.queryText ? `Posts: ${pipeline.queryText}` : 'Posts'}</h2>
      <PostGrid grid={grid} tags={route.tags} linkTo={linkTo} src={`user:${name}`} />
    </Columns>
  );
}
