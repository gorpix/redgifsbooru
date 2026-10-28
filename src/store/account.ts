// Likes and follows of the logged-in RedGifs user: a Set loaded once per login, with optimistic
// toggles that revert when the write fails. In memory only (the lists belong to the account).

export type AccountSetState = 'idle' | 'loading' | 'ready' | 'error';

/** The part of AuthManager the stores need. */
export interface AuthLike {
  state: string;
  username: string | null;
  subscribe(listener: () => void): () => void;
}

export class NotLoggedInError extends Error {
  constructor() {
    super('Log in on RedGifs first');
    this.name = 'NotLoggedInError';
  }
}

export interface AccountSetOptions {
  load: () => Promise<string[]>;
  add: (key: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
  auth?: AuthLike | null;
  /** Key normalisation for lookups; default lower case. */
  normalize?: (key: string) => string;
}

export class AccountSet {
  state: AccountSetState = 'idle';
  private items = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  /** Account the list was loaded for; a change (logout, other user) clears it. */
  private loadedFor: string | null = null;
  private generation = 0;
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly normalize: (key: string) => string;

  constructor(private readonly options: AccountSetOptions) {
    this.normalize = options.normalize ?? ((k) => k.toLowerCase());
    options.auth?.subscribe(() => this.onAuth());
  }

  private onAuth(): void {
    const auth = this.options.auth;
    if (!auth) return;
    if (auth.state !== 'loggedIn') {
      if (this.state !== 'idle') this.reset();
      return;
    }
    // Same login: keep the list. A different account: start over.
    if (this.loadedFor !== null && auth.username !== null && auth.username !== this.loadedFor) this.reset();
  }

  private reset(): void {
    this.generation += 1;
    this.items = new Set();
    this.state = 'idle';
    this.loadedFor = null;
    this.loading = null;
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* a bad listener must not stop the others */ }
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get size(): number {
    return this.items.size;
  }

  has(key: string): boolean {
    return this.items.has(this.normalize(key));
  }

  /** Snapshot of the keys (normalised). */
  all(): string[] {
    return [...this.items];
  }

  /** Loads the list once per login. Resolves quietly on failure (state 'error'); call again to retry. */
  ensureLoaded(): Promise<void> {
    if (this.state === 'ready' || !this.canLoad()) return Promise.resolve();
    if (!this.loading) {
      const run: Promise<void> = this.fetch().finally(() => { if (this.loading === run) this.loading = null; });
      this.loading = run;
    }
    return this.loading;
  }

  /** Loads again from RedGifs, e.g. after a failure. */
  reload(): Promise<void> {
    this.loading = null;
    return this.ensureLoaded();
  }

  private canLoad(): boolean {
    return !this.options.auth || this.options.auth.state === 'loggedIn';
  }

  private async fetch(): Promise<void> {
    const auth = this.options.auth;
    const generation = this.generation;
    this.state = 'loading';
    this.emit();
    try {
      const list = await this.options.load();
      if (generation !== this.generation) return;
      this.items = new Set(list.map(this.normalize));
      this.loadedFor = auth?.username ?? null;
      this.state = 'ready';
    } catch {
      if (generation !== this.generation) return;
      this.state = 'error';
    }
    this.emit();
  }

  /**
   * Sets membership with an optimistic update: the change shows at once and is reverted
   * (and the error rethrown) when RedGifs refuses it. Writes for one key run in order.
   * Resolves to the new value.
   */
  set(key: string, on: boolean): Promise<boolean> {
    const auth = this.options.auth;
    if (auth && auth.state !== 'loggedIn') return Promise.reject(new NotLoggedInError());
    const norm = this.normalize(key);
    const exec = async (): Promise<boolean> => {
      const before = this.items.has(norm);
      if (before === on) return on;
      const generation = this.generation;
      this.apply(norm, on);
      try {
        await (on ? this.options.add(key) : this.options.remove(key));
        return on;
      } catch (error) {
        if (generation === this.generation) this.apply(norm, before);
        throw error;
      }
    };
    // With nothing pending for this key the change shows at once (synchronously).
    const previous = this.chains.get(norm);
    const run = previous ? previous.catch(() => undefined).then(exec) : exec();
    this.chains.set(norm, run);
    void run.then(() => undefined, () => undefined).then(() => { if (this.chains.get(norm) === run) this.chains.delete(norm); });
    return run;
  }

  /** Flips membership; resolves to the new value. */
  toggle(key: string): Promise<boolean> {
    return this.set(key, !this.has(key));
  }

  private apply(norm: string, on: boolean): void {
    if (on) this.items.add(norm);
    else this.items.delete(norm);
    this.emit();
  }
}

/** Minimal shape of the account API the stores use. */
export interface AccountSource {
  likedIds(): Promise<string[]>;
  like(id: string): Promise<void>;
  unlike(id: string): Promise<void>;
  followedNames(): Promise<string[]>;
  follow(name: string): Promise<void>;
  unfollow(name: string): Promise<void>;
}

export const createLikesStore = (account: AccountSource, auth: AuthLike | null = null): AccountSet =>
  new AccountSet({ load: () => account.likedIds(), add: (id) => account.like(id), remove: (id) => account.unlike(id), auth });

export const createFollowsStore = (account: AccountSource, auth: AuthLike | null = null): AccountSet =>
  new AccountSet({ load: () => account.followedNames(), add: (n) => account.follow(n), remove: (n) => account.unfollow(n), auth });
