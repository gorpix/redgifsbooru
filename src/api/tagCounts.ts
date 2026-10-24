// Global post counts per tag (how many posts RedGifs has), looked up lazily via
// the suggest endpoint at low priority and cached in localStorage in the same
// format RedGIFS-X uses: { "<key>": [count | null, savedAtMs, [similar…]] }.
import { normalizeTag } from '../search/tags';
import type { RedgifsApi } from './client';

export type TagCountEntry = [count: number | null, savedAt: number, similar: string[]];
export type TagCountEntries = Record<string, TagCountEntry>;

export const TAG_COUNTS_KEY = 'rgb:tag-counts';
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;
const SAVE_DELAY_MS = 500;
const RETRY_FAILED_MS = 5 * 60 * 1000;
const CONCURRENCY = 2;
const SIMILAR_COUNT = 4;

/** Keeps well-formed entries that are not older than the max age. */
function cleanEntries(raw: unknown, now: number): Map<string, TagCountEntry> {
  const out = new Map<string, TagCountEntry>();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const [count, savedAt, similar] = value;
    if (typeof savedAt !== 'number' || !Number.isFinite(savedAt) || now - savedAt > MAX_AGE_MS) continue;
    if (count !== null && !(typeof count === 'number' && Number.isFinite(count))) continue;
    const k = normalizeTag(key);
    if (!k) continue;
    const list = Array.isArray(similar) ? similar.filter((s): s is string => typeof s === 'string') : [];
    out.set(k, [count, savedAt, list]);
  }
  return out;
}

export class TagCounts {
  private readonly entries: Map<string, TagCountEntry>;
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Set<string>();
  private readonly failed = new Map<string, number>();
  private readonly queue: string[] = [];
  private running = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly api: Pick<RedgifsApi, 'suggestTags'>,
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null,
    private readonly now: () => number = Date.now,
  ) {
    let raw: unknown = null;
    try {
      const text = storage?.getItem(TAG_COUNTS_KEY);
      raw = text ? JSON.parse(text) : null;
    } catch {
      raw = null;
    }
    this.entries = cleanEntries(raw, now());
  }

  /** The tag's global post count; null = RedGifs has no such tag; undefined = unknown or loading. */
  get(name: string): number | null | undefined {
    return this.entries.get(normalizeTag(name))?.[0];
  }

  /** Up to 4 similar tags RedGifs suggested for this one. */
  similar(name: string): string[] {
    return this.entries.get(normalizeTag(name))?.[2] ?? [];
  }

  /** Looks up counts for names not yet known (or whose lookup failed more than 5 minutes ago). */
  request(names: string[]): void {
    for (const name of names) {
      const key = normalizeTag(name);
      if (!key || this.entries.has(key) || this.pending.has(key)) continue;
      const failedAt = this.failed.get(key);
      if (failedAt !== undefined && this.now() - failedAt < RETRY_FAILED_MS) continue;
      this.pending.add(key);
      this.queue.push(key);
    }
    this.pump();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Merges entries in the persisted format (used by import); the newer savedAt wins. */
  merge(entries: unknown): void {
    const incoming = cleanEntries(entries, this.now());
    let changed = false;
    for (const [key, entry] of incoming) {
      const have = this.entries.get(key);
      if (!have || entry[1] > have[1]) {
        this.entries.set(key, entry);
        changed = true;
      }
    }
    if (changed) {
      this.notify();
      this.scheduleSave();
    }
  }

  private pump(): void {
    while (this.running < CONCURRENCY && this.queue.length) {
      const key = this.queue.shift() as string;
      this.running += 1;
      void this.lookup(key).finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }

  private async lookup(key: string): Promise<void> {
    try {
      const suggestions = await this.api.suggestTags(key, { priority: 'low' });
      const exact = suggestions.find((s) => normalizeTag(s.text) === key);
      this.entries.set(key, [exact ? exact.count : null, this.now(), suggestions.slice(0, SIMILAR_COUNT).map((s) => s.text)]);
      this.failed.delete(key);
      this.scheduleSave();
    } catch {
      this.failed.set(key, this.now());
    } finally {
      this.pending.delete(key);
    }
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* a bad listener must not stop the others */ }
    }
  }

  private scheduleSave(): void {
    if (!this.storage || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DELAY_MS);
  }

  private save(): void {
    if (!this.storage) return;
    const newest = [...this.entries].sort((a, b) => b[1][1] - a[1][1]).slice(0, MAX_ENTRIES);
    try {
      this.storage.setItem(TAG_COUNTS_KEY, JSON.stringify(Object.fromEntries(newest)));
    } catch { /* storage full or blocked */ }
  }
}
