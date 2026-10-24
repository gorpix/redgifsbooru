// Fills numbered booru pages from RedGifs' stream of server pages. The stream is
// walked in order; items that pass `check` are placed into booru pages of `pageSize`.
// Page n starts exactly where page n-1's last match was taken.

import type { Gif } from '../api/types';

export interface StreamPage { gifs: Gif[]; pages: number } // pages = server page count
export type FetchStreamPage = (serverPage: number, signal: AbortSignal) => Promise<StreamPage>;
/** null = keep; otherwise a reason string, tallied in FillState.rejected. */
export type Check = (gif: Gif) => string | null;
export interface Cursor { serverPage: number; index: number } // next unread item

export interface FillState {
  page: number;
  posts: Gif[];
  pageSize: number;
  phase: 'seeking' | 'filling' | 'done' | 'paused' | 'error';
  /** While seeking: the earlier page currently being filled to locate the start of `page`. */
  seekingPage?: number;
  serverPagesScanned: number;
  rejected: Record<string, number>;
  endReached: boolean;
  lastPage: number | null;
  knownPages: number;
  error?: unknown;
}

export interface FillerOptions {
  key: string;
  fetchPage: FetchStreamPage;
  check: Check;
  pageSize?: number;
  maxServerPagesPerRun?: number;
  maxServerPage?: number;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  now?: () => number;
}

const CURSOR_PREFIX = 'rgb:cursor:';
const CURSOR_MAX_AGE_MS = 30 * 60 * 1000;
const POSITION_SPAN = 1_000_000; // item position = serverPage * span + index

/** Work in progress on one booru page; survives a pause, an abort or an error. */
interface Progress {
  page: number;
  cursor: Cursor; // next unread item
  posts: Gif[];
  rejected: Record<string, number>;
}

interface RunContext {
  page: number; // page the caller asked for
  scanned: number; // server pages fetched in this fill() call
  onUpdate: (state: FillState) => void;
  signal?: AbortSignal;
}

type ScanResult = 'complete' | 'ended' | 'paused';

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function isCursor(value: unknown): value is Cursor {
  const c = value as Cursor | null;
  return !!c && Number.isInteger(c.serverPage) && c.serverPage >= 1 && Number.isInteger(c.index) && c.index >= 0;
}

export class PageFiller {
  private readonly key: string;
  private readonly fetchPage: FetchStreamPage;
  private readonly check: Check;
  private readonly pageSize: number;
  private readonly maxRun: number;
  private readonly maxServerPage: number;
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  private readonly now: () => number;

  /** starts[n-1] = where booru page n starts. */
  private starts: Cursor[] = [{ serverPage: 1, index: 0 }];
  private lastPage: number | null = null;
  private serverPages: number | null = null; // from the latest response
  private progress: Progress | null = null;
  /**
   * id -> lowest stream position it was seen at. An item is a duplicate only if the id was
   * seen at an EARLIER position, so rescanning a page (after a jump back, or after discarding
   * partial progress) sees the same items as the first time and nothing needs undoing.
   * With starts loaded from storage the pages before them were never scanned in this
   * instance, so dedupe against those is best-effort (ids seen only in this instance).
   */
  private readonly seen = new Map<string, number>();

  constructor(options: FillerOptions) {
    this.key = options.key;
    this.fetchPage = options.fetchPage;
    this.check = options.check;
    this.pageSize = options.pageSize ?? 75;
    this.maxRun = options.maxServerPagesPerRun ?? 20;
    this.maxServerPage = options.maxServerPage ?? 100;
    this.storage = options.storage ?? null;
    this.now = options.now ?? (() => Date.now());
    this.load();
  }

  /** Not re-entrant: abort the previous fill() before starting another on the same instance. */
  async fill(page: number, onUpdate: (state: FillState) => void, signal?: AbortSignal): Promise<FillState> {
    const ctx: RunContext = { page, scanned: 0, onUpdate, signal };
    for (;;) {
      if (this.lastPage !== null && page > this.lastPage) {
        const state = this.snapshot(ctx, 'done', [], {});
        onUpdate(state);
        return state;
      }
      // Earlier pages are filled one at a time until the start of `page` is known.
      const target = this.starts.length >= page ? page : this.starts.length;
      const result = await this.scan(target, ctx);
      const p = this.progress;
      const mine = target === page && p !== null && p.page === page;
      if (result === 'paused') {
        const state = this.snapshot(ctx, 'paused', mine ? p.posts : [], mine ? p.rejected : {});
        onUpdate(state);
        return state;
      }
      if (target === page) {
        const state = this.snapshot(ctx, 'done', mine ? p.posts : [], mine ? p.rejected : {});
        this.progress = null;
        onUpdate(state);
        return state;
      }
      this.progress = null; // an earlier page finished (or the stream ended); keep seeking
    }
  }

  /** Walks the stream from the start (or saved progress) of page `target`. */
  private async scan(target: number, ctx: RunContext): Promise<ScanResult> {
    if (this.progress?.page !== target) {
      this.progress = { page: target, cursor: { ...this.starts[target - 1] }, posts: [], rejected: {} };
    }
    const p = this.progress;
    const seeking = target !== ctx.page;
    const view = (phase: FillState['phase'], error?: unknown) =>
      this.snapshot(ctx, phase, seeking ? [] : p.posts, seeking ? {} : p.rejected, seeking ? target : undefined, error);

    for (;;) {
      const sp = p.cursor.serverPage;
      if (sp > this.maxServerPage || (this.serverPages !== null && sp > this.serverPages)) return this.endStream(p);
      if (ctx.signal?.aborted) throw abortError(ctx.signal);
      if (ctx.scanned >= this.maxRun) return 'paused';

      let res: StreamPage;
      try {
        res = await this.fetchPage(sp, ctx.signal ?? new AbortController().signal);
      } catch (error) {
        if (ctx.signal?.aborted) throw abortError(ctx.signal);
        ctx.onUpdate(view('error', error));
        throw error;
      }
      if (ctx.signal?.aborted) throw abortError(ctx.signal);
      ctx.scanned++;
      if (typeof res.pages === 'number' && Number.isFinite(res.pages)) this.serverPages = res.pages;
      if (res.gifs.length === 0) return this.endStream(p);

      for (let i = p.cursor.index; i < res.gifs.length; i++) {
        const gif = res.gifs[i];
        const pos = sp * POSITION_SPAN + i;
        const first = this.seen.get(gif.id);
        if (first !== undefined && first < pos) continue; // duplicate: neither match nor rejection
        if (first === undefined || first > pos) this.seen.set(gif.id, pos);
        const reason = this.check(gif);
        if (reason === null) p.posts.push(gif);
        else p.rejected[reason] = (p.rejected[reason] ?? 0) + 1;
        if (p.posts.length >= this.pageSize) {
          // The next page starts right after this match.
          const next: Cursor = i + 1 >= res.gifs.length ? { serverPage: sp + 1, index: 0 } : { serverPage: sp, index: i + 1 };
          if (this.starts.length === target) this.starts.push(next);
          this.save();
          return 'complete';
        }
      }
      p.cursor = { serverPage: sp + 1, index: 0 };
      ctx.onUpdate(view(seeking ? 'seeking' : 'filling'));
    }
  }

  private endStream(p: Progress): ScanResult {
    this.lastPage = p.posts.length > 0 ? p.page : Math.max(1, p.page - 1);
    if (this.starts.length > this.lastPage) this.starts.length = this.lastPage;
    this.save();
    return 'ended';
  }

  private snapshot(
    ctx: RunContext,
    phase: FillState['phase'],
    posts: Gif[],
    rejected: Record<string, number>,
    seekingPage?: number,
    error?: unknown,
  ): FillState {
    const state: FillState = {
      page: ctx.page,
      posts: posts.slice(),
      pageSize: this.pageSize,
      phase,
      serverPagesScanned: ctx.scanned,
      rejected: { ...rejected },
      endReached: this.lastPage !== null,
      lastPage: this.lastPage,
      knownPages: this.starts.length,
    };
    if (seekingPage !== undefined) state.seekingPage = seekingPage;
    if (phase === 'error') state.error = error;
    return state;
  }

  private load(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(CURSOR_PREFIX + this.key);
      if (!raw) return;
      const data = JSON.parse(raw) as { at?: unknown; starts?: unknown; lastPage?: unknown };
      if (typeof data.at !== 'number' || this.now() - data.at >= CURSOR_MAX_AGE_MS) return;
      if (!Array.isArray(data.starts) || data.starts.length === 0 || !data.starts.every(isCursor)) return;
      const first = data.starts[0] as Cursor;
      if (first.serverPage !== 1 || first.index !== 0) return;
      const last = data.lastPage;
      if (last !== null && !(typeof last === 'number' && Number.isInteger(last) && last >= 1)) return;
      this.starts = data.starts as Cursor[];
      this.lastPage = last as number | null;
    } catch {
      // ignore unreadable records
    }
  }

  private save(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(CURSOR_PREFIX + this.key, JSON.stringify({ at: this.now(), starts: this.starts, lastPage: this.lastPage }));
    } catch {
      // storage full or blocked
    }
  }
}
