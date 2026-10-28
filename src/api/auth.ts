// RedGifs login, borrowed from the user's own RedGifs session. We never see a password: the
// httpOnly Kinde refresh cookie is exchanged for a short-lived id_token by a request that runs
// in the PAGE world (see pageRunner.ts). The id_token is what RedGifs' API accepts.
//
// SECURITY: token values live in memory only. They are never written to localStorage,
// sessionStorage or IndexedDB, never put in the DOM, never logged and never put in debug
// events (those carry lengths and booleans). There is no logout call anywhere.
//
// Several booru tabs may be open: one lock (`rgb:auth-lock`, localStorage, 15 s lease) lets a
// single tab refresh at a time, and it shares the fresh token with the others over a
// BroadcastChannel (in memory in the browser, never persisted).
import { jwtExpiry } from './token';
import { realClock, type Clock } from './queue';

export const KINDE_CLIENT_ID = 'e06c34dac7654821bcb37e0393b54350';
export const REFRESH_BODY = `client_id=${KINDE_CLIENT_ID}&grant_type=refresh_token`;
export const AUTH_LOCK_KEY = 'rgb:auth-lock';
export const AUTH_CHANNEL = 'rgb-auth';

/** getToken() refreshes when the token has less than this left. */
export const TOKEN_MARGIN_MS = 5 * 60_000;
/** Keep-alive refreshes when the token has less than this left. */
export const KEEPALIVE_MARGIN_MS = 10 * 60_000;
const LOCK_LEASE_MS = 15_000;
const PEER_WAIT_MS = 500;
/** Do not retry a failed/logged-out check more often than this on focus. */
const FOCUS_RETRY_MS = 30_000;
const MIN_TIMER_MS = 30_000;
const DEFAULT_LIFETIME_MS = 55 * 60_000;

export type AuthState = 'unknown' | 'loggedIn' | 'loggedOut' | 'error';

/** Runs the refresh POST in the page world; `body` is the form body. Never throws; status 0 = failed. */
export type PageRunner = (body: string) => Promise<{ status: number; json: unknown }>;

/** What a debug hook sees. Lengths and flags only: never a token. */
export type AuthDebugEvent =
  | { type: 'refresh'; outcome: 'loggedIn' | 'loggedOut' | 'error'; status: number; tokenLength: number; hasExpiry: boolean; source: 'own' | 'peer' }
  | { type: 'state'; state: AuthState; hasUsername: boolean }
  | { type: 'keepalive'; inMs: number }
  | { type: 'lock'; outcome: 'acquired' | 'busy' };

export interface ChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  close?(): void;
}

export type AuthStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type TimerFn = (fn: () => void, ms: number) => () => void;

export interface AuthOptions {
  runner: PageRunner;
  /** Cross-tab lock storage (localStorage); none = no lock (single tab). */
  storage?: AuthStorage | null;
  /** Creates the shared channel; default `BroadcastChannel`, which may be missing. */
  createChannel?: (name: string) => ChannelLike | null;
  clock?: Clock;
  /** Schedules a callback and returns its canceller. Default setTimeout. */
  setTimer?: TimerFn;
  /** Default true. */
  keepLoggedIn?: boolean;
  /** This tab's lock owner id. */
  ownerId?: string;
  onDebug?: (event: AuthDebugEvent) => void;
}

interface Held {
  token: string;
  /** Unix ms. */
  expiresAt: number;
}

interface PeerToken { type: 'token'; token: string; expiresAt: number; username?: string | null }

const defaultTimer: TimerFn = (fn, ms) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

function defaultCreateChannel(name: string): ChannelLike | null {
  try {
    return typeof BroadcastChannel === 'function' ? (new BroadcastChannel(name) as unknown as ChannelLike) : null;
  } catch {
    return null;
  }
}

function randomId(): string {
  try {
    return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
}

export class AuthManager {
  state: AuthState = 'unknown';
  username: string | null = null;

  private held: Held | null = null;
  private pending: Promise<boolean> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly runner: PageRunner;
  private readonly storage: AuthStorage | null;
  private readonly clock: Clock;
  private readonly setTimer: TimerFn;
  private readonly channel: ChannelLike | null;
  private readonly owner: string;
  private readonly onDebug?: (event: AuthDebugEvent) => void;
  private keepLoggedIn: boolean;
  private cancelTimer: (() => void) | null = null;
  private lastAttemptAt = 0;
  private usernameLoader: (() => Promise<string | null>) | null = null;
  private usernameLoading: Promise<void> | null = null;
  /** Resolvers waiting for a token from a peer tab. */
  private readonly peerWaiters = new Set<() => void>();

  constructor(options: AuthOptions) {
    this.runner = options.runner;
    this.storage = options.storage ?? null;
    this.clock = options.clock ?? realClock;
    this.setTimer = options.setTimer ?? defaultTimer;
    this.keepLoggedIn = options.keepLoggedIn ?? true;
    this.owner = options.ownerId ?? randomId();
    this.onDebug = options.onDebug;
    this.channel = (options.createChannel ?? defaultCreateChannel)(AUTH_CHANNEL);
    this.channel?.addEventListener('message', (event) => this.onMessage(event.data));
  }

  // ---- observation -------------------------------------------------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isLoggedIn(): boolean {
    return this.state === 'loggedIn';
  }

  /** Supplies the `/v1/me` lookup (RedgifsApi does it, so the request goes through the api). */
  setUsernameLoader(loader: () => Promise<string | null>): void {
    this.usernameLoader = loader;
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* a bad listener must not stop the others */ }
    }
  }

  private debug(event: AuthDebugEvent): void {
    try { this.onDebug?.(event); } catch { /* a debug hook must never break auth */ }
  }

  private setState(state: AuthState, username: string | null = this.username): void {
    if (state === this.state && username === this.username) return;
    this.state = state;
    this.username = state === 'loggedIn' ? username : null;
    this.debug({ type: 'state', state, hasUsername: this.username !== null });
    this.emit();
  }

  // ---- tokens ------------------------------------------------------------------------

  private hasToken(marginMs: number): boolean {
    return this.state === 'loggedIn' && this.held !== null && this.held.expiresAt - marginMs > this.clock.now();
  }

  /**
   * The id_token to send to RedGifs, or null when the user is not logged in (callers then
   * use the guest token). Refreshes first when there is none or it expires within 5 minutes.
   * Logged out / error states return null without hitting the network.
   */
  async getToken(): Promise<string | null> {
    if (this.hasToken(TOKEN_MARGIN_MS)) return this.held!.token;
    if (this.state === 'loggedOut' || this.state === 'error') return null;
    await this.refresh();
    return this.hasToken(0) ? this.held!.token : null;
  }

  /**
   * Gets a fresh id_token from the user's RedGifs session. Without `force`, does nothing when
   * the current token still has more than `marginMs` left. Concurrent callers share one run;
   * across tabs only the lock holder asks RedGifs. Resolves true when logged in afterwards.
   */
  refresh(force = false, marginMs = TOKEN_MARGIN_MS): Promise<boolean> {
    if (!force && this.hasToken(marginMs)) return Promise.resolve(true);
    if (!this.pending) {
      this.pending = this.runRefresh(force, marginMs).finally(() => { this.pending = null; });
    }
    const run = this.pending;
    return run.then(async (ok) => {
      if (ok) await this.ensureUsername();
      return ok;
    });
  }

  /** First check when the booru starts: asks other tabs for a token (500 ms), else refreshes. */
  async start(): Promise<void> {
    if (this.channel && this.state === 'unknown') {
      let wake: () => void = () => undefined;
      const arrived = new Promise<void>((resolve) => { wake = resolve; this.peerWaiters.add(resolve); });
      this.post({ type: 'need' });
      await Promise.race([arrived, this.clock.sleep(PEER_WAIT_MS)]);
      this.peerWaiters.delete(wake);
    }
    if (this.state === 'unknown') await this.refresh();
    else this.scheduleKeepAlive();
  }

  /** Call when the tab becomes visible/focused: picks up a login made in another tab. */
  async checkNow(): Promise<void> {
    const now = this.clock.now();
    if (this.state === 'loggedIn') {
      if (this.keepLoggedIn && !this.hasToken(KEEPALIVE_MARGIN_MS)) await this.refresh(false, KEEPALIVE_MARGIN_MS);
      return;
    }
    if (now - this.lastAttemptAt < FOCUS_RETRY_MS && this.lastAttemptAt !== 0) return;
    await this.refresh(true);
  }

  /** The API got 401 with the user token and a refreshed one did not help: do NOT log out. */
  markError(): void {
    this.setState('error');
  }

  setKeepLoggedIn(value: boolean): void {
    if (value === this.keepLoggedIn) return;
    this.keepLoggedIn = value;
    this.scheduleKeepAlive();
  }

  /** Stops timers and the channel. */
  dispose(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    try { this.channel?.close?.(); } catch { /* ignore */ }
  }

  // ---- refresh -----------------------------------------------------------------------

  private async runRefresh(force: boolean, marginMs: number): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      // A peer may have delivered a token while we waited.
      if (!force && this.hasToken(marginMs)) return true;
      if (this.tryLock()) {
        this.debug({ type: 'lock', outcome: 'acquired' });
        try {
          return await this.ownRefresh();
        } finally {
          this.releaseLock();
        }
      }
      this.debug({ type: 'lock', outcome: 'busy' });
      const until = this.readLock()?.until ?? this.clock.now() + LOCK_LEASE_MS;
      const waitMs = Math.max(0, until - this.clock.now()) + 250;
      const before = this.held?.token;
      await this.waitForPeer(waitMs);
      // Another tab's fresh token satisfies even a forced refresh.
      if (this.hasToken(marginMs) && this.held!.token !== before) return true;
      if (!force && this.hasToken(marginMs)) return true;
    }
    return this.hasToken(0);
  }

  private async ownRefresh(): Promise<boolean> {
    this.lastAttemptAt = this.clock.now();
    let status = 0;
    let json: unknown = null;
    try {
      ({ status, json } = await this.runner(REFRESH_BODY));
    } catch {
      status = 0;
    }
    const idToken = readString(json, 'id_token');
    if (status === 200 && idToken) {
      const expiresAt = this.expiryOf(idToken, json);
      this.held = { token: idToken, expiresAt };
      this.debug({ type: 'refresh', outcome: 'loggedIn', status, tokenLength: idToken.length, hasExpiry: true, source: 'own' });
      this.setState('loggedIn');
      this.post({ type: 'token', token: idToken, expiresAt, username: this.username } satisfies PeerToken);
      this.scheduleKeepAlive();
      return true;
    }
    if (status === 400 || status === 401) {
      // The RedGifs session is gone. We only forget our copy; no logout is ever called.
      this.held = null;
      this.debug({ type: 'refresh', outcome: 'loggedOut', status, tokenLength: 0, hasExpiry: false, source: 'own' });
      this.setState('loggedOut');
      this.post({ type: 'loggedOut' });
      this.cancelTimer?.();
      this.cancelTimer = null;
      return false;
    }
    this.debug({ type: 'refresh', outcome: 'error', status, tokenLength: 0, hasExpiry: false, source: 'own' });
    // A transient failure keeps a still-valid token; otherwise report an error (not logged out).
    if (this.hasToken(0)) return true;
    this.held = null;
    this.setState('error');
    return false;
  }

  private expiryOf(idToken: string, json: unknown): number {
    const now = this.clock.now();
    const exp = jwtExpiry(idToken);
    if (exp > now) return exp;
    const seconds = readNumber(json, 'expires_in');
    return now + (seconds !== null && seconds > 0 ? seconds * 1000 : DEFAULT_LIFETIME_MS);
  }

  private async ensureUsername(): Promise<void> {
    if (this.state !== 'loggedIn' || this.username !== null || !this.usernameLoader) return;
    this.usernameLoading ??= (async () => {
      try {
        const name = await this.usernameLoader!();
        if (name && this.state === 'loggedIn') {
          this.setState('loggedIn', name);
          this.post({ type: 'username', username: name });
        }
      } catch {
        // Not fatal: the account indicator just has no name yet.
      }
    })().finally(() => { this.usernameLoading = null; });
    await this.usernameLoading;
  }

  // ---- keep-alive --------------------------------------------------------------------

  private scheduleKeepAlive(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (!this.keepLoggedIn || this.state !== 'loggedIn' || !this.held) return;
    const inMs = Math.max(MIN_TIMER_MS, this.held.expiresAt - KEEPALIVE_MARGIN_MS - this.clock.now());
    this.debug({ type: 'keepalive', inMs });
    this.cancelTimer = this.setTimer(() => {
      this.cancelTimer = null;
      void this.refresh(false, KEEPALIVE_MARGIN_MS).then((ok) => {
        // Failed or already refreshed by a peer: look again later.
        if (ok || this.state === 'loggedIn') this.scheduleKeepAlive();
      });
    }, inMs);
  }

  // ---- cross-tab ---------------------------------------------------------------------

  private readLock(): { owner: string; until: number } | null {
    try {
      const raw = this.storage?.getItem(AUTH_LOCK_KEY);
      const parsed = raw ? (JSON.parse(raw) as { owner?: unknown; until?: unknown }) : null;
      return parsed && typeof parsed.owner === 'string' && typeof parsed.until === 'number'
        ? { owner: parsed.owner, until: parsed.until }
        : null;
    } catch {
      return null;
    }
  }

  /** Takes the lease when it is free, expired or ours. Without storage there is no lock. */
  private tryLock(): boolean {
    if (!this.storage) return true;
    const now = this.clock.now();
    const lock = this.readLock();
    if (lock && lock.owner !== this.owner && lock.until > now) return false;
    try {
      this.storage.setItem(AUTH_LOCK_KEY, JSON.stringify({ owner: this.owner, until: now + LOCK_LEASE_MS }));
    } catch {
      return true;
    }
    // Read back: if another tab wrote at the same moment, only the last writer holds it.
    return this.readLock()?.owner === this.owner;
  }

  private releaseLock(): void {
    try {
      if (this.readLock()?.owner === this.owner) this.storage?.removeItem(AUTH_LOCK_KEY);
    } catch { /* ignore */ }
  }

  private waitForPeer(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => { this.peerWaiters.delete(done); resolve(); };
      this.peerWaiters.add(done);
      void this.clock.sleep(ms).then(done);
    });
  }

  private post(message: object): void {
    try { this.channel?.postMessage(message); } catch { /* channel closed */ }
  }

  private wakePeerWaiters(): void {
    for (const resolve of [...this.peerWaiters]) resolve();
  }

  private onMessage(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const msg = data as Record<string, unknown>;
    if (msg.type === 'need') {
      if (this.hasToken(TOKEN_MARGIN_MS)) {
        this.post({ type: 'token', token: this.held!.token, expiresAt: this.held!.expiresAt, username: this.username } satisfies PeerToken);
      }
    } else if (msg.type === 'token') {
      if (typeof msg.token !== 'string' || !msg.token || typeof msg.expiresAt !== 'number') return;
      if (msg.expiresAt <= this.clock.now()) return;
      if (!this.held || msg.expiresAt > this.held.expiresAt || this.state !== 'loggedIn') {
        this.held = { token: msg.token, expiresAt: msg.expiresAt };
        this.debug({ type: 'refresh', outcome: 'loggedIn', status: 200, tokenLength: msg.token.length, hasExpiry: true, source: 'peer' });
        this.setState('loggedIn', typeof msg.username === 'string' && msg.username ? msg.username : this.username);
        this.scheduleKeepAlive();
      }
      this.wakePeerWaiters();
    } else if (msg.type === 'username') {
      if (typeof msg.username === 'string' && msg.username && this.state === 'loggedIn') this.setState('loggedIn', msg.username);
    } else if (msg.type === 'loggedOut') {
      if (this.state === 'loggedIn' && !this.pending) {
        this.held = null;
        this.setState('loggedOut');
      }
      this.wakePeerWaiters();
    }
  }
}

function readString(json: unknown, key: string): string | null {
  const v = json && typeof json === 'object' ? (json as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' && v ? v : null;
}

function readNumber(json: unknown, key: string): number | null {
  const v = json && typeof json === 'object' ? (json as Record<string, unknown>)[key] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
