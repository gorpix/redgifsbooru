// Pure helpers for the account UI (login gate, error notes, blacklist import, sets): kept out of the
// components so they can be tested. Nothing here touches a token.
import { parseBlacklist } from '../search/match';
import { normalizeTag } from '../search/tags';
import { NotLoggedInError } from '../store/account';

export const LOGIN_URL = 'https://www.redgifs.com/login';

/** What a page that needs the RedGifs account should do for a login state. */
export type AccountGate = 'ok' | 'checking' | 'loggedOut' | 'error';

export function accountGate(state: string): AccountGate {
  switch (state) {
    case 'loggedIn': return 'ok';
    case 'loggedOut': return 'loggedOut';
    case 'error': return 'error';
    default: return 'checking';
  }
}

/** What the header's account indicator shows for a login state. */
export type AccountIndicator =
  | { kind: 'user'; label: string }
  | { kind: 'login' }
  | { kind: 'problem' };

export function accountIndicator(state: string, username: string | null): AccountIndicator {
  if (state === 'loggedIn') return { kind: 'user', label: username || 'My account' };
  if (state === 'error') return { kind: 'problem' };
  return { kind: 'login' };
}

/** Text shown instead of an account page's content; null when the page can run. `what` completes "to see your ...". */
export function gateNotice(gate: AccountGate, what: string): string | null {
  switch (gate) {
    case 'ok': return null;
    case 'checking': return 'Checking your RedGifs login…';
    case 'loggedOut': return `Log in on RedGifs to see your ${what}.`;
    case 'error': return 'There is a problem with your RedGifs login. See Settings → Account.';
  }
}

export interface ActionNote {
  kind: 'login' | 'error';
  text: string;
}

/** The note shown next to a favorite / follow / set control when its request failed. */
export function actionNote(error: unknown, verb: string): ActionNote {
  if (error instanceof NotLoggedInError) return { kind: 'login', text: `Log in on RedGifs to ${verb}` };
  const detail = error instanceof Error && error.message ? `: ${error.message.slice(0, 80)}` : '';
  return { kind: 'error', text: `Could not ${verb}${detail}` };
}

// ---------------------------------------------------------------- blacklist import

/**
 * Appends RedGifs' blocked tags to the blacklist text (one per line, like the RedGIFS-X import).
 * A tag already blocked as an exact rule (underscores, hyphens and spaces count the same) is skipped.
 */
export function importBlockedTags(existing: string, tags: string[]): { text: string; added: number } {
  const have = new Set(parseBlacklist(existing).filter((r) => r.mode === 'exact').map((r) => r.value));
  const fresh: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    const key = normalizeTag(tag);
    if (!key || /^[-*]/.test(tag) || have.has(key)) continue;
    have.add(key);
    fresh.push(tag);
  }
  if (fresh.length === 0) return { text: existing, added: 0 };
  return { text: [existing.trimEnd(), ...fresh].filter(Boolean).join('\n'), added: fresh.length };
}

export function describeBlockedImport(added: number, total: number): string {
  if (total === 0) return 'RedGifs has no blocked tags for this account.';
  if (added === 0) return `All ${total} blocked ${total === 1 ? 'tag is' : 'tags are'} already in your blacklist.`;
  return `Added ${added} of ${total} blocked ${total === 1 ? 'tag' : 'tags'} to your blacklist.`;
}

// ---------------------------------------------------------------- sets

export const MAX_SET_NAME = 100;

/** A problem with a set name, or null when it is fine. */
export function setNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'A set needs a name.';
  if (trimmed.length > MAX_SET_NAME) return `A set name can be at most ${MAX_SET_NAME} characters.`;
  return null;
}

export function visibilityLabel(published: boolean): string {
  return published ? 'public' : 'private';
}

/** Session-only memory of which of my sets a post was added to (RedGifs has no "sets containing this post" call). */
export class SetMembership {
  private readonly added = new Map<string, Set<string>>();

  has(gifId: string, setId: string): boolean {
    return this.added.get(gifId)?.has(setId) ?? false;
  }

  add(gifId: string, setId: string): void {
    const sets = this.added.get(gifId) ?? new Set<string>();
    sets.add(setId);
    this.added.set(gifId, sets);
  }

  remove(gifId: string, setId: string): void {
    this.added.get(gifId)?.delete(setId);
  }

  /** A set was deleted or emptied of this post: forget it. */
  forgetSet(setId: string): void {
    for (const sets of this.added.values()) sets.delete(setId);
  }
}

/** The page's shared memory (module level, so it survives moving between posts). */
export const setMembership = new SetMembership();
