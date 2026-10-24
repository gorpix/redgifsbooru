// Tag aliases (e621 style): a typed tag that is not a RedGifs tag is rewritten to the one meant.
import type { BlacklistRule } from './match';
import type { Query } from './query';

const MAX_HOPS = 5;

/** User entries override built-ins; a user entry mapping a key to itself disables the built-in. */
export function buildAliasMap(
  builtin: ReadonlyArray<readonly [string, string]>,
  user: ReadonlyArray<{ from: string; to: string }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const [from, to] of builtin) map.set(from, to);
  for (const { from, to } of user) {
    if (from === to) map.delete(from);
    else map.set(from, to);
  }
  return map;
}

/** Follows chains up to 5 hops, stopping on cycles; returns the final key. */
export function resolveAlias(key: string, map: ReadonlyMap<string, string>): string {
  const seen = new Set([key]);
  let current = key;
  for (let i = 0; i < MAX_HOPS; i++) {
    const next = map.get(current);
    if (next === undefined || seen.has(next)) break;
    seen.add(next);
    current = next;
  }
  return current;
}

export function applyAliases(
  query: Query,
  map: ReadonlyMap<string, string>,
): { query: Query; applied: { from: string; to: string }[] } {
  const applied = new Map<string, string>();
  const rewrite = (key: string): string => {
    const to = resolveAlias(key, map);
    if (to !== key) applied.set(key, to);
    return to;
  };
  const list = (keys: string[]) => [...new Set(keys.map(rewrite))];

  const seenEx = new Set<string>();
  const exclusions = [];
  for (const e of query.exclusions) {
    const value = e.mode === 'exact' ? rewrite(e.value) : e.value;
    const k = `${e.mode}:${value}`;
    if (seenEx.has(k)) continue;
    seenEx.add(k);
    exclusions.push(value === e.value ? e : { mode: e.mode, value });
  }

  const result: Query = { ...query, required: list(query.required), any: list(query.any), exclusions };
  return { query: result, applied: [...applied].map(([from, to]) => ({ from, to })) };
}

export function aliasBlacklist(rules: BlacklistRule[], map: ReadonlyMap<string, string>): BlacklistRule[] {
  const seen = new Set<string>();
  const out: BlacklistRule[] = [];
  for (const rule of rules) {
    const value = rule.mode === 'exact' ? resolveAlias(rule.value, map) : rule.value;
    const key = `${rule.mode}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value === rule.value ? rule : { mode: rule.mode, value, key });
  }
  return out;
}
