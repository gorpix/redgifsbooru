// One-time import of RedGIFS-X's data. Both scripts run on redgifs.com, so its
// localStorage keys are readable from here.
import type { TagCountEntries } from '../api/tagCounts';
import { toTagTerm } from '../search/tags';
import { getBlacklistText, getPausedKeys, setBlacklistText, setPausedKeys } from './blacklist';
import { saveSearch } from './saved';
import { mergeSeen } from './seen';
import { readJson, readText, stringList, type KeyValueStorage } from './storage';

export const RGX_KEYS = {
  blacklist: 'rg-view-sort:tag-blacklist-v1',
  paused: 'rg-view-sort:blacklist-disabled-v1',
  saved: 'rg-view-sort:saved-searches-v1',
  seen: 'rg-view-sort:seen-v1',
  tagCounts: 'rg-view-sort:tag-counts-v1',
} as const;

export interface ImportCounts {
  /** Blacklist entries. */
  blacklist: number;
  /** Paused rule keys. */
  paused: number;
  /** Saved searches that convert to a booru query. */
  saved: number;
  /** Saved searches skipped (user pages, nothing convertible). */
  skippedSaved: number;
  seen: number;
  tagCounts: number;
}

const splitEntries = (text: string) => text.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);

/** Converts a RedGIFS-X saved-search URL into booru query text, or null when it cannot be. */
export function redgifsXUrlToQuery(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url, 'https://www.redgifs.com');
  } catch {
    return null;
  }
  if (/^\/users\//i.test(parsed.pathname)) return null;
  const params = parsed.searchParams;
  const terms = (name: string, prefix: string) =>
    params.getAll(name).map(toTagTerm).filter(Boolean).map((t) => prefix + t);

  let required = terms('rg-tag', '');
  if (!required.length) {
    const text = toTagTerm(params.get('query') ?? '');
    if (text) required = [text];
  }
  const filters = params.getAll('rg-filter').map((f) => f.trim()).filter(Boolean);
  const order = (params.get('rg-order') ?? '').trim();
  const parts = [
    ...required,
    ...terms('rg-exclude', '-'),
    ...terms('rg-exclude-contains', '--'),
    ...terms('rg-any', '~'),
    ...filters,
    ...(order ? [`order:${order}`] : []),
  ];
  return parts.length ? parts.join(' ') : null;
}

function readSaved(storage: KeyValueStorage): Array<{ name: string; query: string | null }> {
  const raw = readJson(RGX_KEYS.saved, storage);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item.url === 'string')
    .map((item) => ({ name: typeof item.name === 'string' ? item.name : '', query: redgifsXUrlToQuery(item.url) }));
}

function readTagCounts(storage: KeyValueStorage): TagCountEntries {
  const raw = readJson(RGX_KEYS.tagCounts, storage);
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as TagCountEntries) : {};
}

/** What RedGIFS-X data is present, without changing anything. */
export function detectRedgifsX(storage: KeyValueStorage | null): ImportCounts {
  const counts: ImportCounts = { blacklist: 0, paused: 0, saved: 0, skippedSaved: 0, seen: 0, tagCounts: 0 };
  if (!storage) return counts;
  counts.blacklist = splitEntries(readText(RGX_KEYS.blacklist, storage) ?? '').length;
  counts.paused = stringList(readJson(RGX_KEYS.paused, storage)).length;
  for (const item of readSaved(storage)) {
    if (item.query) counts.saved += 1;
    else counts.skippedSaved += 1;
  }
  counts.seen = stringList(readJson(RGX_KEYS.seen, storage)).length;
  counts.tagCounts = Object.keys(readTagCounts(storage)).length;
  return counts;
}

/**
 * Copies RedGIFS-X's data into the booru's own keys (same storage) and returns what was
 * imported: entries newly added for blacklist, paused and seen; converted/skipped for saved.
 */
export function importRedgifsX(storage: KeyValueStorage | null, tagCounts?: { merge(entries: TagCountEntries): void } | null): ImportCounts {
  const counts: ImportCounts = { blacklist: 0, paused: 0, saved: 0, skippedSaved: 0, seen: 0, tagCounts: 0 };
  if (!storage) return counts;

  const theirText = readText(RGX_KEYS.blacklist, storage) ?? '';
  const ours = getBlacklistText(storage);
  const have = new Set(splitEntries(ours).map((s) => s.toLowerCase()));
  const added: string[] = [];
  for (const entry of splitEntries(theirText)) {
    const key = entry.toLowerCase();
    if (have.has(key)) continue;
    have.add(key);
    added.push(entry);
  }
  if (added.length) {
    setBlacklistText([ours.trimEnd(), ...added].filter(Boolean).join('\n'), storage);
    counts.blacklist = added.length;
  }

  const paused = stringList(readJson(RGX_KEYS.paused, storage));
  const havePaused = new Set(getPausedKeys(storage));
  const newPaused = [...new Set(paused)].filter((k) => !havePaused.has(k));
  if (newPaused.length) {
    setPausedKeys([...havePaused, ...newPaused], storage);
    counts.paused = newPaused.length;
  }

  for (const item of readSaved(storage)) {
    if (item.query) {
      saveSearch(item.name || item.query, item.query, storage);
      counts.saved += 1;
    } else {
      counts.skippedSaved += 1;
    }
  }

  counts.seen = mergeSeen(stringList(readJson(RGX_KEYS.seen, storage)), storage);

  const entries = readTagCounts(storage);
  counts.tagCounts = Object.keys(entries).length;
  if (counts.tagCounts && tagCounts) tagCounts.merge(entries);

  return counts;
}
