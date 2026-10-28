import { describe, expect, it, vi } from 'vitest';
import { AUTH_LOCK_KEY, AuthManager, REFRESH_BODY, type AuthDebugEvent, type ChannelLike, type PageRunner } from '../src/api/auth';
import { buildPageScript } from '../src/api/pageRunner';
import type { Clock } from '../src/api/queue';

/** A clock whose sleeps only finish when the test advances time. */
function makeClock(start = 1_000_000) {
  const sleeps: Array<{ at: number; resolve: () => void }> = [];
  const clock = {
    t: start,
    now: () => clock.t,
    sleep: (ms: number) => new Promise<void>((resolve) => { sleeps.push({ at: clock.t + ms, resolve }); }),
    async advance(ms: number) {
      clock.t += ms;
      for (const s of sleeps.splice(0)) {
        if (s.at <= clock.t) s.resolve();
        else sleeps.push(s);
      }
      await flush();
    },
  };
  return clock satisfies Clock & { advance(ms: number): Promise<void> };
}

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
  };
}

/** Channels created from one bus hear each other (not themselves), asynchronously like the real thing. */
function makeBus() {
  const members: Array<{ listeners: Array<(e: { data: unknown }) => void> }> = [];
  return (): ChannelLike => {
    const me = { listeners: [] as Array<(e: { data: unknown }) => void> };
    members.push(me);
    return {
      postMessage(message) {
        for (const other of members) {
          if (other === me) continue;
          queueMicrotask(() => other.listeners.forEach((l) => l({ data: JSON.parse(JSON.stringify(message)) })));
        }
      },
      addEventListener(_type, listener) { me.listeners.push(listener); },
    };
  };
}

const okReply = (token: string, expiresIn = 3600) => ({ status: 200, json: { id_token: token, access_token: 'ACCESS-SECRET', refresh_token: 'REFRESH-SECRET', expires_in: expiresIn } });

function scriptedRunner(replies: Array<{ status: number; json: unknown } | Error>) {
  const calls: string[] = [];
  const runner: PageRunner = async (body) => {
    calls.push(body);
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { runner, calls };
}

function make(replies: Array<{ status: number; json: unknown } | Error>, extra: Partial<ConstructorParameters<typeof AuthManager>[0]> = {}) {
  const clock = makeClock();
  const { runner, calls } = scriptedRunner(replies);
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const auth = new AuthManager({
    runner,
    clock,
    createChannel: () => null,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    ...extra,
  });
  return { auth, calls, clock, timers };
}

describe('AuthManager.refresh', () => {
  it('logs in with an id_token, sends the contract body, and tells subscribers', async () => {
    const { auth, calls } = make([okReply('IDTOK1')]);
    const seen: string[] = [];
    auth.subscribe(() => seen.push(auth.state));
    expect(auth.state).toBe('unknown');
    expect(await auth.refresh()).toBe(true);
    expect(auth.state).toBe('loggedIn');
    expect(calls).toEqual([REFRESH_BODY]);
    expect(REFRESH_BODY).toBe('client_id=e06c34dac7654821bcb37e0393b54350&grant_type=refresh_token');
    expect(await auth.getToken()).toBe('IDTOK1');
    expect(seen).toContain('loggedIn');
  });

  it('treats 400 as logged out and does not ask again on getToken', async () => {
    const { auth, calls } = make([{ status: 400, json: { error: 'invalid_grant' } }]);
    expect(await auth.refresh()).toBe(false);
    expect(auth.state).toBe('loggedOut');
    expect(auth.username).toBeNull();
    expect(await auth.getToken()).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('reports an error (not logged out) for network failure, server errors and a missing id_token', async () => {
    for (const reply of [{ status: 0, json: null }, { status: 500, json: null }, { status: 200, json: { access_token: 'x' } }, new Error('boom')]) {
      const { auth } = make([reply]);
      expect(await auth.refresh()).toBe(false);
      expect(auth.state).toBe('error');
      expect(await auth.getToken()).toBeNull();
    }
  });

  it('keeps a still-valid token through a transient failure', async () => {
    const { auth, clock } = make([okReply('IDTOK1'), { status: 500, json: null }]);
    await auth.refresh();
    await clock.advance(10 * 60_000);
    expect(await auth.refresh(true)).toBe(true);
    expect(auth.state).toBe('loggedIn');
  });

  it('shares one run between concurrent callers', async () => {
    const { auth, calls } = make([okReply('IDTOK1')]);
    const results = await Promise.all([auth.refresh(), auth.refresh(true), auth.getToken()]);
    expect(results).toEqual([true, true, 'IDTOK1']);
    expect(calls).toHaveLength(1);
  });

  it('loads the username through the supplied loader after a login', async () => {
    const { auth } = make([okReply('IDTOK1')]);
    const loader = vi.fn(async () => 'someone');
    auth.setUsernameLoader(loader);
    await auth.refresh();
    expect(auth.username).toBe('someone');
    await auth.refresh();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('survives a failing username loader', async () => {
    const { auth } = make([okReply('IDTOK1')]);
    auth.setUsernameLoader(async () => { throw new Error('nope'); });
    expect(await auth.refresh()).toBe(true);
    expect(auth.state).toBe('loggedIn');
    expect(auth.username).toBeNull();
  });
});

describe('AuthManager.getToken', () => {
  it('caches the token and refreshes when less than 5 minutes remain', async () => {
    const { auth, calls, clock } = make([okReply('IDTOK1'), okReply('IDTOK2')]);
    expect(await auth.getToken()).toBe('IDTOK1'); // state unknown: refreshes
    await clock.advance(54 * 60_000); // 6 min left
    expect(await auth.getToken()).toBe('IDTOK1');
    expect(calls).toHaveLength(1);
    await clock.advance(61_000); // 4 min left
    expect(await auth.getToken()).toBe('IDTOK2');
    expect(calls).toHaveLength(2);
  });

  it('reads the expiry from the JWT when it has one', async () => {
    const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '');
    const clock = makeClock();
    const exp = Math.floor(clock.t / 1000) + 20 * 60;
    const jwt = `${b64({ alg: 'none' })}.${b64({ exp })}.sig`;
    const { auth, calls } = make([okReply(jwt, 3600), okReply('IDTOK2')], { clock });
    await auth.getToken();
    await clock.advance(16 * 60_000); // 4 min left on the JWT, 44 on expires_in
    expect(await auth.getToken()).toBe('IDTOK2');
    expect(calls).toHaveLength(2);
  });
});

describe('AuthManager across tabs', () => {
  function twoTabs(replies: Parameters<typeof make>[0]) {
    const clock = makeClock();
    const storage = memoryStorage();
    const channel = makeBus();
    const runs = scriptedRunner(replies);
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow: PageRunner = async (body) => { await gate; return runs.runner(body); };
    const mk = (ownerId: string) => new AuthManager({ runner: slow, clock, storage, createChannel: channel, ownerId, setTimer: () => () => undefined });
    return { a: mk('tab-a'), b: mk('tab-b'), storage, clock, runs, release: () => release!() };
  }

  it('lets only one tab refresh; the other receives the token', async () => {
    const { a, b, runs, release, storage } = twoTabs([okReply('SHARED-TOKEN')]);
    const pa = a.refresh();
    await flush();
    const pb = b.refresh();
    await flush();
    expect(JSON.parse(storage.data.get(AUTH_LOCK_KEY)!).owner).toBe('tab-a');
    release();
    expect(await Promise.all([pa, pb])).toEqual([true, true]);
    expect(runs.calls).toHaveLength(1);
    expect(await b.getToken()).toBe('SHARED-TOKEN');
    expect(b.state).toBe('loggedIn');
    expect(storage.data.has(AUTH_LOCK_KEY)).toBe(false); // lock released
  });

  it('takes over when the lock holder died (lease expires)', async () => {
    const { b, runs, release, storage, clock } = twoTabs([okReply('MINE')]);
    storage.data.set(AUTH_LOCK_KEY, JSON.stringify({ owner: 'dead-tab', until: clock.t + 15_000 }));
    release();
    const p = b.refresh();
    await flush();
    expect(runs.calls).toHaveLength(0);
    await clock.advance(15_300);
    expect(await p).toBe(true);
    expect(runs.calls).toHaveLength(1);
  });

  it('a new tab asks peers first and adopts their token without refreshing', async () => {
    const { a, b, runs, release, clock } = twoTabs([okReply('PEER-TOKEN')]);
    release();
    await a.refresh();
    const started = b.start();
    await flush();
    await clock.advance(0);
    await started;
    expect(runs.calls).toHaveLength(1);
    expect(b.state).toBe('loggedIn');
    expect(await b.getToken()).toBe('PEER-TOKEN');
  });

  it('a new tab refreshes itself after 500 ms when no peer answers', async () => {
    const { auth, calls, clock } = make([okReply('IDTOK1')], { createChannel: makeBus() });
    const started = auth.start();
    await flush();
    expect(calls).toHaveLength(0);
    await clock.advance(500);
    await started;
    expect(calls).toHaveLength(1);
    expect(auth.state).toBe('loggedIn');
  });

  it('works as a single tab when BroadcastChannel is missing', async () => {
    const { auth, calls } = make([okReply('IDTOK1')], { createChannel: () => null });
    await auth.start();
    expect(auth.state).toBe('loggedIn');
    expect(calls).toHaveLength(1);
  });

  it('works without a lock storage', async () => {
    const { auth } = make([okReply('IDTOK1')], { storage: null });
    expect(await auth.refresh()).toBe(true);
  });

  it('never persists a token', async () => {
    const storage = memoryStorage();
    const { auth } = make([okReply('IDTOK-SECRET-VALUE')], { storage });
    await auth.refresh();
    expect(JSON.stringify([...storage.data])).not.toMatch(/SECRET/);
  });
});

describe('AuthManager keep-alive', () => {
  it('schedules a refresh for when 10 minutes remain, and re-schedules after it', async () => {
    const { auth, calls, clock, timers } = make([okReply('IDTOK1'), okReply('IDTOK2')]);
    await auth.refresh();
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(50 * 60_000);
    await clock.advance(50 * 60_000);
    timers[0].fn();
    await flush();
    expect(calls).toHaveLength(2);
    expect(await auth.getToken()).toBe('IDTOK2');
    expect(timers.slice(1).filter((t) => !t.cancelled)).toHaveLength(1); // exactly one pending after the fired one
    expect(timers[timers.length - 1].ms).toBe(50 * 60_000);
  });

  it('does not schedule when keepLoggedIn is off, and starts when it is switched on', async () => {
    const { auth, timers } = make([okReply('IDTOK1')], { keepLoggedIn: false });
    await auth.refresh();
    expect(timers).toHaveLength(0);
    auth.setKeepLoggedIn(true);
    expect(timers).toHaveLength(1);
    auth.setKeepLoggedIn(false);
    expect(timers[0].cancelled).toBe(true);
  });

  it('does not refresh from a timer that fires early (a peer already did it)', async () => {
    const { auth, calls, timers } = make([okReply('IDTOK1')]);
    await auth.refresh();
    timers[0].fn(); // clock has not moved: 60 min left
    await flush();
    expect(calls).toHaveLength(1);
  });
});

describe('AuthManager.checkNow', () => {
  it('picks up a login made after a logged-out check, but not more than every 30 s', async () => {
    const { auth, calls, clock } = make([{ status: 400, json: null }, okReply('IDTOK1')]);
    await auth.refresh();
    expect(auth.state).toBe('loggedOut');
    await auth.checkNow();
    expect(calls).toHaveLength(1);
    await clock.advance(31_000);
    await auth.checkNow();
    expect(auth.state).toBe('loggedIn');
    expect(calls).toHaveLength(2);
  });
});

describe('401 hook', () => {
  it('markError sets the error state without logging out', async () => {
    const { auth } = make([okReply('IDTOK1')]);
    await auth.refresh();
    auth.markError();
    expect(auth.state).toBe('error');
    expect(await auth.getToken()).toBeNull();
  });
});

describe('debug output', () => {
  it('shows lengths and flags only, never a token value', async () => {
    const events: AuthDebugEvent[] = [];
    const { auth, timers } = make([okReply('IDTOK-VERY-SECRET'), okReply('IDTOK-ALSO-SECRET')], { onDebug: (e) => events.push(e) });
    auth.setUsernameLoader(async () => 'someone');
    await auth.refresh();
    await auth.refresh(true);
    auth.markError();
    const text = JSON.stringify(events) + JSON.stringify(timers.map((t) => t.ms));
    expect(text).not.toMatch(/SECRET/);
    expect(text).not.toMatch(/REFRESH/);
    expect(text).not.toMatch(/ACCESS/);
    expect(events.find((e) => e.type === 'refresh')).toMatchObject({ outcome: 'loggedIn', tokenLength: 'IDTOK-VERY-SECRET'.length, hasExpiry: true });
  });
});

describe('page script', () => {
  it('uses the contract request, removes itself and leaves nothing on window', () => {
    const script = buildPageScript('rgb-evt', REFRESH_BODY);
    expect(script).toContain('https://auth2.redgifs.com/oauth2/token');
    expect(script).toContain("credentials:'include'");
    expect(script).toContain('Kinde-SDK');
    expect(script).toContain('s.remove()');
    expect(script).toContain('"rgb-evt"');
    expect(script).not.toMatch(/window\./);
    expect(script).not.toMatch(/localStorage|sessionStorage|logout/i);
  });
});
