import { describe, expect, it } from 'vitest';
import { AccountSet, NotLoggedInError, createFollowsStore, createLikesStore, type AccountSource } from '../src/store/account';

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeAuth(state = 'loggedIn', username: string | null = 'alice') {
  const listeners = new Set<() => void>();
  const auth: { state: string; username: string | null; subscribe: (l: () => void) => () => boolean; set: (next: string, name?: string | null) => void } = {
    state, username,
    subscribe: (l: () => void) => { listeners.add(l); return () => listeners.delete(l); },
    set(next: string, name: string | null = auth.username) { auth.state = next; auth.username = name; listeners.forEach((l) => l()); },
  };
  return auth;
}

function source(overrides: Partial<AccountSource> = {}) {
  const calls: string[] = [];
  const src: AccountSource = {
    likedIds: async () => { calls.push('likedIds'); return ['A', 'b']; },
    like: async (id) => { calls.push(`like ${id}`); },
    unlike: async (id) => { calls.push(`unlike ${id}`); },
    followedNames: async () => { calls.push('followedNames'); return ['Bob']; },
    follow: async (n) => { calls.push(`follow ${n}`); },
    unfollow: async (n) => { calls.push(`unfollow ${n}`); },
    ...overrides,
  };
  return { src, calls };
}

describe('likes store', () => {
  it('loads once and answers has() case-insensitively', async () => {
    const { src, calls } = source();
    const likes = createLikesStore(src, fakeAuth());
    expect(likes.state).toBe('idle');
    await Promise.all([likes.ensureLoaded(), likes.ensureLoaded()]);
    await likes.ensureLoaded();
    expect(calls).toEqual(['likedIds']);
    expect(likes.state).toBe('ready');
    expect(likes.has('a')).toBe(true);
    expect(likes.has('A')).toBe(true);
    expect(likes.has('zzz')).toBe(false);
    expect(likes.size).toBe(2);
  });

  it('applies like optimistically and keeps it on success', async () => {
    const gate = deferred();
    const { src } = source({ like: async () => gate.promise });
    const likes = createLikesStore(src, fakeAuth());
    await likes.ensureLoaded();
    let notified = 0;
    likes.subscribe(() => notified++);
    const p = likes.toggle('new');
    expect(likes.has('new')).toBe(true); // before the server answered
    expect(notified).toBe(1);
    gate.resolve();
    expect(await p).toBe(true);
    expect(likes.has('new')).toBe(true);
  });

  it('reverts a failed like and rethrows', async () => {
    const { src } = source({ like: async () => { throw new Error('refused'); } });
    const likes = createLikesStore(src, fakeAuth());
    await likes.ensureLoaded();
    let notified = 0;
    likes.subscribe(() => notified++);
    await expect(likes.toggle('new')).rejects.toThrow('refused');
    expect(likes.has('new')).toBe(false);
    expect(notified).toBe(2); // add, then revert
  });

  it('reverts a failed unlike back to liked', async () => {
    const { src } = source({ unlike: async () => { throw new Error('refused'); } });
    const likes = createLikesStore(src, fakeAuth());
    await likes.ensureLoaded();
    await expect(likes.toggle('b')).rejects.toThrow();
    expect(likes.has('b')).toBe(true);
  });

  it('runs writes for one id in order and does not repeat a no-op', async () => {
    const first = deferred();
    const { src, calls } = source({ like: async (id) => { calls.push(`like ${id}`); await first.promise; } });
    const likes = createLikesStore(src, fakeAuth());
    await likes.ensureLoaded();
    const a = likes.set('x', true);
    const b = likes.set('x', false);
    await flush();
    expect(calls).toEqual(['likedIds', 'like x']); // unlike waits
    first.resolve();
    await Promise.all([a, b]);
    expect(calls).toEqual(['likedIds', 'like x', 'unlike x']);
    expect(likes.has('x')).toBe(false);
    await likes.set('x', false);
    expect(calls).toHaveLength(3);
  });

  it('refuses to write when logged out, without changing anything', async () => {
    const { src, calls } = source();
    const likes = createLikesStore(src, fakeAuth('loggedOut', null));
    await expect(likes.toggle('a')).rejects.toBeInstanceOf(NotLoggedInError);
    expect(calls).toEqual([]);
    expect(likes.has('a')).toBe(false);
  });

  it('does not load while logged out, and reports a failed load as error; reload() retries', async () => {
    let fail = true;
    const { src } = source({ likedIds: async () => { if (fail) throw new Error('x'); return ['a']; } });
    const auth = fakeAuth('loggedOut', null);
    const likes = createLikesStore(src, auth);
    await likes.ensureLoaded();
    expect(likes.state).toBe('idle');
    auth.set('loggedIn', 'alice');
    await likes.ensureLoaded();
    expect(likes.state).toBe('error');
    fail = false;
    await likes.reload();
    expect(likes.state).toBe('ready');
    expect(likes.has('a')).toBe(true);
  });

  it('clears on logout and when another account logs in, then loads again', async () => {
    const { src, calls } = source();
    const auth = fakeAuth('loggedIn', 'alice');
    const likes = createLikesStore(src, auth);
    await likes.ensureLoaded();
    auth.set('loggedIn', 'alice'); // token refresh: same account keeps the list
    expect(likes.state).toBe('ready');
    auth.set('loggedIn', 'bobby');
    expect(likes.state).toBe('idle');
    expect(likes.size).toBe(0);
    await likes.ensureLoaded();
    auth.set('loggedOut', null);
    expect(likes.state).toBe('idle');
    auth.set('loggedIn', 'alice');
    await likes.ensureLoaded();
    expect(calls.filter((c) => c === 'likedIds')).toHaveLength(3);
  });

  it('a revert after a logout does not resurrect state', async () => {
    const gate = deferred();
    const { src } = source({ like: async () => gate.promise });
    const auth = fakeAuth();
    const likes = createLikesStore(src, auth);
    await likes.ensureLoaded();
    const p = likes.toggle('n');
    auth.set('loggedOut', null);
    gate.reject(new Error('late'));
    await expect(p).rejects.toThrow('late');
    expect(likes.size).toBe(0);
  });
});

describe('follows store', () => {
  it('uses usernames and the follow endpoints with the original spelling', async () => {
    const { src, calls } = source();
    const follows = createFollowsStore(src, fakeAuth());
    await follows.ensureLoaded();
    expect(follows.has('bob')).toBe(true);
    await follows.toggle('Carol');
    expect(follows.has('carol')).toBe(true);
    await follows.toggle('Bob');
    expect(follows.has('bob')).toBe(false);
    expect(calls).toEqual(['followedNames', 'follow Carol', 'unfollow Bob']);
  });

  it('is a plain AccountSet that works without an auth object', async () => {
    const set = new AccountSet({ load: async () => ['x'], add: async () => undefined, remove: async () => undefined });
    await set.ensureLoaded();
    expect(set.all()).toEqual(['x']);
  });
});
