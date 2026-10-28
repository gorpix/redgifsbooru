// Shared account state for the UI: the auth manager and the likes / follows stores, passed down
// through a context so thumbnails, headers and buttons need no extra props.
import { createContext } from 'preact';
import { useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AuthManager } from '../api/auth';
import type { AccountSet } from '../store/account';
import { accountGate, actionNote, type AccountGate, type ActionNote } from './accountHelpers';

export interface AccountContextValue {
  auth: AuthManager;
  likes: AccountSet;
  follows: AccountSet;
}

export const AccountContext = createContext<AccountContextValue | null>(null);

export function useAccount(): AccountContextValue | null {
  return useContext(AccountContext);
}

/** Re-renders on every change of `source`; returns a change counter. */
function useChanges(source: { subscribe(listener: () => void): () => void } | null): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!source) return undefined;
    const unsubscribe = source.subscribe(() => setVersion((v) => v + 1));
    // A change between the first render and this effect (e.g. a peer tab's login arriving)
    // would otherwise be missed: re-render once now that we are listening.
    setVersion((v) => v + 1);
    return unsubscribe;
  }, [source]);
  return version;
}

/** The login state, kept current. Without a context (tests) it is 'unknown'. */
export function useAuthState(): { state: string; username: string | null; gate: AccountGate } {
  const account = useAccount();
  useChanges(account?.auth ?? null);
  const state = account?.auth.state ?? 'unknown';
  return { state, username: account?.auth.username ?? null, gate: accountGate(state) };
}

/** Loads the store's list once the user is logged in. */
export function useEnsureLoaded(store: AccountSet | null): void {
  const { state } = useAuthState();
  useEffect(() => {
    if (store && state === 'loggedIn') void store.ensureLoaded();
  }, [store, state]);
}

export interface FollowedNames {
  /** 'loading' until the follows list is known (or while logged out). */
  state: 'loading' | 'ready' | 'error';
  /** Followed usernames (lower case, sorted); empty until ready. */
  names: string[];
}

/** The usernames I follow, kept current (loads the list once logged in). */
export function useFollowedNames(enabled = true): FollowedNames {
  const account = useAccount();
  const follows = account?.follows ?? null;
  useChanges(follows);
  useEnsureLoaded(enabled ? follows : null);
  if (!follows) return { state: 'loading', names: [] };
  if (follows.state === 'error') return { state: 'error', names: [] };
  if (follows.state !== 'ready') return { state: 'loading', names: [] };
  return { state: 'ready', names: follows.all().sort() };
}

const NOTE_MS = 6000;

/** A favorite / follow toggle for one key: current value, a click handler and a note about a failure. */
export function useAccountToggle(store: AccountSet | null, key: string, verb: string) {
  useChanges(store);
  const [note, setNote] = useState<ActionNote | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const toggle = useMemo(() => async () => {
    if (!store) return;
    clearTimeout(timer.current);
    setNote(null);
    try {
      // The list must be known first, or an already-liked post would be "liked" again.
      await store.ensureLoaded();
      await store.toggle(key);
    } catch (error) {
      setNote(actionNote(error, verb));
      timer.current = setTimeout(() => setNote(null), NOTE_MS);
    }
  }, [store, key, verb]);
  return { on: store?.has(key) ?? false, toggle, note };
}
