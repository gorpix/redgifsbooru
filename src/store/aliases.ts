import { normalizeTag, toTagTerm } from '../search/tags';
import { createChannel, defaultStorage, readText, writeText, type KeyValueStorage } from './storage';

export const ALIASES_KEY = 'rgb:aliases';

const channel = createChannel([ALIASES_KEY]);

/** Raw user alias text: one `from -> to` (or `from => to`) per line. */
export function getAliasText(storage: KeyValueStorage | null = defaultStorage()): string {
  return readText(ALIASES_KEY, storage) ?? '';
}

export function setAliasText(text: string, storage: KeyValueStorage | null = defaultStorage()): void {
  writeText(ALIASES_KEY, text, storage);
  channel.notify();
}

const SEPARATOR_RE = /^(.*?)\s*(?:->|=>)\s*(.*)$/;

function parseLine(line: string): { from: string; to: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const m = SEPARATOR_RE.exec(trimmed);
  if (!m) return null;
  const from = normalizeTag(m[1]);
  const to = normalizeTag(m[2]);
  return from && to ? { from, to } : null;
}

/** Valid alias lines, normalized; invalid lines are skipped. */
export function parseAliasText(text: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const entry = parseLine(line);
    if (entry) out.push(entry);
  }
  return out;
}

/** Adds `from -> to`, replacing any existing line for `from`. */
export function addUserAlias(from: string, to: string, storage: KeyValueStorage | null = defaultStorage()): void {
  const f = normalizeTag(from);
  const t = normalizeTag(to);
  if (!f || !t) return;
  const newLine = `${toTagTerm(f)} -> ${toTagTerm(t)}`;
  const lines = getAliasText(storage).split(/\r?\n/);
  let replaced = false;
  const next: string[] = [];
  for (const line of lines) {
    if (parseLine(line)?.from === f) {
      if (!replaced) next.push(newLine);
      replaced = true;
    } else {
      next.push(line);
    }
  }
  if (!replaced) {
    while (next.length > 0 && next[next.length - 1].trim() === '') next.pop();
    next.push(newLine);
  }
  setAliasText(next.join('\n'), storage);
}

export const subscribeAliases = channel.subscribe;
