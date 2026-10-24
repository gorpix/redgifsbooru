// A request budget shared by every booru tab (same origin, so same localStorage): a sliding
// window of request start times. RedGifs sends no rate-limit headers, so we stay under a
// self-imposed cap instead of waiting for HTTP 429.

export type BudgetPriority = 'high' | 'low';
type Mark = 'h' | 'l';
type Entry = [startedAt: number, mark: Mark];
type BudgetStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const REQUEST_LOG_KEY = 'rgb:request-log';
/** Unix ms until which every request is held back (written on HTTP 429, read by all tabs). */
export const RATE_LIMIT_KEY = 'rgb:rate-limit-until';
/** Unix ms until which low-priority requests are held back (set after a 429). */
export const LOW_PAUSED_KEY = 'rgb:low-paused-until';

export const WINDOW_MS = 60_000;
export const MAX_STARTS = 30;
export const MAX_LOW_STARTS = 6;

/** A stored unix-ms number, or 0 when missing, garbage or unreadable. */
export function readStoredNumber(storage: Pick<Storage, 'getItem'> | null | undefined, key: string): number {
  try {
    const n = Number(storage?.getItem(key));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Stores `value` unless a larger value is already there (a pause never gets shorter). */
export function writeStoredMax(storage: BudgetStorage | null | undefined, key: string, value: number): void {
  try {
    if (!storage || readStoredNumber(storage, key) >= value) return;
    storage.setItem(key, String(Math.round(value)));
  } catch {
    // storage full or blocked
  }
}

function parseLog(text: string | null): Entry[] | null {
  if (text === null) return [];
  try {
    const raw: unknown = JSON.parse(text);
    if (!Array.isArray(raw)) return null;
    return raw.filter((e): e is Entry =>
      Array.isArray(e) && typeof e[0] === 'number' && Number.isFinite(e[0]) && (e[1] === 'h' || e[1] === 'l'));
  } catch {
    return null;
  }
}

export class RequestBudget {
  /** Used when storage is missing, throws, or holds garbage. */
  private memory: Entry[] = [];

  constructor(private readonly storage: BudgetStorage | null = null) {}

  private read(now: number): Entry[] {
    let log: Entry[] | null = null;
    try {
      log = this.storage ? parseLog(this.storage.getItem(REQUEST_LOG_KEY)) : null;
    } catch {
      log = null;
    }
    return (log ?? this.memory).filter((e) => e[0] > now - WINDOW_MS);
  }

  /** Milliseconds until a request of this priority may start; 0 when it may start now. */
  waitTime(priority: BudgetPriority, now: number): number {
    const log = this.read(now).sort((a, b) => a[0] - b[0]);
    // The start that must age out of the window before one more fits under `limit`.
    const until = (entries: Entry[], limit: number) =>
      entries.length >= limit ? entries[entries.length - limit][0] + WINDOW_MS - now : 0;
    let wait = until(log, MAX_STARTS);
    if (priority === 'low') wait = Math.max(wait, until(log.filter((e) => e[1] === 'l'), MAX_LOW_STARTS));
    return Math.max(0, wait);
  }

  /** Notes that a request starts at `now`. */
  record(priority: BudgetPriority, now: number): void {
    const log = this.read(now);
    log.push([now, priority === 'low' ? 'l' : 'h']);
    this.memory = log;
    try {
      this.storage?.setItem(REQUEST_LOG_KEY, JSON.stringify(log));
    } catch {
      // the in-memory log still counts this tab's requests
    }
  }
}
