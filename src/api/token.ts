// Guest token from GET /v2/auth/temporary, kept in memory and localStorage.
import { API_ROOT } from './guard';
import { HttpError, type Transport } from './http';

const STORAGE_KEY = 'rgb:guest-token';
// Refresh a little before the token's own expiry.
const EXPIRY_MARGIN_MS = 60_000;

interface StoredToken {
  token: string;
  /** Unix ms; 0 when the token does not say. */
  expiresAt: number;
}

/** Reads `exp` from a JWT without verifying it; 0 if absent or unreadable. */
export function jwtExpiry(token: string): number {
  try {
    const payload = token.split('.')[1];
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof json.exp === 'number' ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export type TokenStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export class TokenManager {
  private current: StoredToken | null;
  private pending: Promise<string> | null = null;

  constructor(
    private readonly transport: Transport,
    private readonly storage: TokenStorage | null = null,
    private readonly now: () => number = Date.now,
  ) {
    this.current = this.load();
  }

  private load(): StoredToken | null {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as StoredToken) : null;
      return parsed && typeof parsed.token === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  private isFresh(stored: StoredToken | null): stored is StoredToken {
    if (!stored) return false;
    return stored.expiresAt === 0 || stored.expiresAt - EXPIRY_MARGIN_MS > this.now();
  }

  /** Returns a usable token. `refresh` forces a new one (after a 401). */
  get(refresh = false): Promise<string> {
    if (refresh && !this.pending) {
      this.current = null;
      try { this.storage?.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
    }
    if (this.isFresh(this.current)) return Promise.resolve(this.current.token);
    this.pending ??= this.fetchToken().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async fetchToken(): Promise<string> {
    const url = `${API_ROOT}/v2/auth/temporary`;
    const response = await this.transport({ url, headers: { Accept: 'application/json' }, timeoutMs: 15_000 });
    if (response.status !== 200) throw new HttpError(response.status, url);
    const data = JSON.parse(response.text) as { token?: unknown };
    if (typeof data.token !== 'string' || !data.token) throw new Error('RedGifs did not return a guest token');
    this.current = { token: data.token, expiresAt: jwtExpiry(data.token) };
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.current)); } catch { /* storage unavailable */ }
    return data.token;
  }
}
