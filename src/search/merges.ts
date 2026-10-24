// Tag merges: several REAL RedGifs tags that mean the same thing are searched and shown as one.
// A group is an ordered list of keys, most popular first; the first key is the canonical tag.
import type { BlacklistRule } from './match';
import type { Query } from './query';
import { normalizeTag, toTagTerm } from './tags';

export interface MergeIndex {
  /** key -> canonical key (identity for keys not in any group). */
  canonical(key: string): string;
  /** key -> all keys of its group, canonical first ([key] when not merged). */
  members(key: string): string[];
}

/** Index with no groups: every key is its own canonical tag. */
export const IDENTITY_INDEX: MergeIndex = {
  canonical: (key) => key,
  members: (key) => [key],
};

/**
 * User groups override built-ins. A built-in group that shares a key with a user group (of 2+ keys)
 * is dropped entirely. A one-key user group removes that key from any built-in group (un-merge);
 * a built-in group left with fewer than 2 keys is dropped. Each key ends up in at most one group
 * (when user groups overlap, the earlier one keeps the key).
 */
export function buildMergeIndex(builtin: ReadonlyArray<ReadonlyArray<string>>, user: string[][]): MergeIndex {
  const claimed = new Set<string>();
  const userGroups: string[][] = [];
  const mentioned = new Set<string>(); // every key a user line mentions
  for (const line of user) {
    const keys = [...new Set(line.map(normalizeTag).filter(Boolean))];
    for (const k of keys) mentioned.add(k);
    const group = keys.filter((k) => !claimed.has(k));
    if (keys.length >= 2 && group.length >= 2) {
      for (const k of group) claimed.add(k);
      userGroups.push(group);
    }
  }

  const groups: string[][] = [];
  for (const raw of builtin) {
    const keys = [...new Set(raw.map(normalizeTag).filter(Boolean))];
    if (keys.some((k) => claimed.has(k))) continue;
    const kept = keys.filter((k) => !mentioned.has(k));
    if (kept.length >= 2) groups.push(kept);
  }
  groups.push(...userGroups);

  const byKey = new Map<string, string[]>();
  for (const g of groups) for (const k of g) if (!byKey.has(k)) byKey.set(k, g);
  return {
    canonical: (key) => byKey.get(key)?.[0] ?? key,
    members: (key) => (byKey.get(key) ?? [key]).slice(),
  };
}

/** Keys of one line (comma separated), normalized and de-duplicated; null for blanks, comments, no keys. */
export function parseMergeLine(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const keys = [...new Set(trimmed.split(',').map(normalizeTag).filter(Boolean))];
  return keys.length > 0 ? keys : null;
}

/** One group per line; single-key lines are kept (they un-merge a built-in key). */
export function parseMergeText(text: string): string[][] {
  const out: string[][] = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const keys = parseMergeLine(line);
    if (keys) out.push(keys);
  }
  return out;
}

/**
 * Reorders every group line by global count, most popular first. Unknown counts (undefined / null)
 * sort last and ties keep the typed order. Comments and blank lines stay as they are.
 */
export function reorderMergeText(text: string, count: (key: string) => number | null | undefined): string {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => {
      const keys = parseMergeLine(line);
      if (!keys) return line;
      const n = (k: string) => {
        const c = count(k);
        return typeof c === 'number' ? c : -1;
      };
      const sorted = keys.map((k, i) => ({ k, i, c: n(k) })).sort((a, b) => b.c - a.c || a.i - b.i);
      return sorted.map((x) => toTagTerm(x.k)).join(', ');
    })
    .join('\n');
}

/** Rewrites required / any / exact exclusions to canonical keys (dedupe). Partial exclusions untouched. */
export function applyMerges(query: Query, index: MergeIndex): { query: Query; applied: { from: string; to: string }[] } {
  const applied = new Map<string, string>();
  const rewrite = (key: string): string => {
    const to = index.canonical(key);
    if (to !== key) applied.set(key, to);
    return to;
  };
  const list = (keys: string[]) => [...new Set(keys.map(rewrite))];

  const seen = new Set<string>();
  const exclusions = [];
  for (const e of query.exclusions) {
    const value = e.mode === 'exact' ? rewrite(e.value) : e.value;
    const id = `${e.mode}:${value}`;
    if (seen.has(id)) continue;
    seen.add(id);
    exclusions.push(value === e.value ? e : { mode: e.mode, value });
  }

  const result: Query = { ...query, required: list(query.required), any: list(query.any), exclusions };
  return { query: result, applied: [...applied].map(([from, to]) => ({ from, to })) };
}

/** Exact blacklist rules expand to one rule per group member (keys recomputed, deduped). */
export function mergeBlacklist(rules: BlacklistRule[], index: MergeIndex): BlacklistRule[] {
  const seen = new Set<string>();
  const out: BlacklistRule[] = [];
  for (const rule of rules) {
    const values = rule.mode === 'exact' ? index.members(rule.value) : [rule.value];
    for (const value of values) {
      const key = `${rule.mode}:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value === rule.value ? rule : { mode: rule.mode, value, key });
    }
  }
  return out;
}
