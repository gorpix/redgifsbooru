// "Follow" / "Unfollow" a creator (the follows store). Shows a short note when the request fails.
import { useAccount, useAccountToggle, useEnsureLoaded } from './account';
import { LOGIN_URL } from './accountHelpers';

export function FollowButton({ name, link = false }: { name: string; /** Render as a text link (post page) instead of a button. */ link?: boolean }) {
  const account = useAccount();
  useEnsureLoaded(account?.follows ?? null);
  const follow = useAccountToggle(account?.follows ?? null, name, 'follow');
  if (!account) return null;
  const label = follow.on ? 'Unfollow' : 'Follow';
  return (
    <span class="rgb-follow">
      <button
        type="button"
        class={link ? 'link-btn' : undefined}
        title={`${label} ${name} on RedGifs`}
        onClick={() => { void follow.toggle(); }}
      >
        {label}
      </button>
      {follow.note && (
        <span class={`rgb-inline-note ${follow.note.kind}`} role="status">
          {' '}
          {follow.note.kind === 'login'
            ? <a href={LOGIN_URL} target="_blank" rel="noopener noreferrer">{follow.note.text}</a>
            : follow.note.text}
        </span>
      )}
    </span>
  );
}
