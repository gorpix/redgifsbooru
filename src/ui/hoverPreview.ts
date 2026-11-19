// Logic of the hover preview on thumbnails: which video to show, the delay, and "one at a time".
import type { Gif } from '../api/types';

/** How long the pointer must rest on a thumbnail before its preview starts. */
export const PREVIEW_DELAY_MS = 250;

/** The video to preview: only videos (type 1) have one; the silent rendition is preferred (smaller). */
export function previewSrc(gif: Pick<Gif, 'type' | 'urls'>): string | undefined {
  if (gif.type !== 1) return undefined;
  return gif.urls.silent ?? gif.urls.sd ?? undefined;
}

let current: (() => void) | null = null;

/** Makes `stop` the page's only running preview: the previous one (if any) is stopped first. */
export function claimPreview(stop: () => void): void {
  if (current && current !== stop) current();
  current = stop;
}

/** `stop` no longer runs (no-op if another preview took over meanwhile). */
export function releasePreview(stop: () => void): void {
  if (current === stop) current = null;
}

interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

/**
 * Starts a preview after the delay. Returns `cancel`: before the delay elapsed it only cancels the
 * start; afterwards it stops the preview. `start` shows the video and returns the function that removes it.
 */
export function schedulePreview(start: () => () => void, delay = PREVIEW_DELAY_MS, timers: Timers = realTimers): () => void {
  let stop: (() => void) | null = null;
  let fired = false;
  const handle = timers.set(() => {
    fired = true;
    const remove = start();
    stop = () => { remove(); releasePreview(stop as () => void); };
    claimPreview(stop);
  }, delay);
  return () => {
    if (!fired) timers.clear(handle);
    else if (stop) { stop(); stop = null; }
  };
}

/** Touch devices have no hover; never start a video there. */
export function canHoverPreview(): boolean {
  try {
    return !globalThis.matchMedia?.('(hover: none)').matches;
  } catch {
    return true;
  }
}
