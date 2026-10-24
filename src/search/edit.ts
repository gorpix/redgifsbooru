// Pure edits of query text, used by the tag sidebar (+ / –) and did-you-mean links.
import { formatQuery, parseQuery } from './query';
import { normalizeTag } from './tags';

/** Requires `key`; any exact exclusion of it is dropped. */
export function addTagToQuery(text: string, key: string): string {
  const k = normalizeTag(key);
  const query = parseQuery(text);
  if (!k) return formatQuery(query);
  query.exclusions = query.exclusions.filter((e) => !(e.mode === 'exact' && e.value === k));
  if (!query.required.includes(k)) query.required = [...query.required, k];
  return formatQuery(query);
}

/** Excludes `key` (exact); it is removed from the required and ~any lists. */
export function excludeTagFromQuery(text: string, key: string): string {
  const k = normalizeTag(key);
  const query = parseQuery(text);
  if (!k) return formatQuery(query);
  query.required = query.required.filter((v) => v !== k);
  query.any = query.any.filter((v) => v !== k);
  if (!query.exclusions.some((e) => e.mode === 'exact' && e.value === k)) {
    query.exclusions = [...query.exclusions, { mode: 'exact', value: k }];
  }
  return formatQuery(query);
}

/** Swaps `fromKey` for `toKey` in the required, ~any and exclusion lists (no duplicates). */
export function replaceTagInQuery(text: string, fromKey: string, toKey: string): string {
  const from = normalizeTag(fromKey);
  const to = normalizeTag(toKey);
  const query = parseQuery(text);
  if (!from || !to) return formatQuery(query);
  const swap = (list: string[]) => [...new Set(list.map((v) => (v === from ? to : v)))];
  query.required = swap(query.required);
  query.any = swap(query.any);
  const seen = new Set<string>();
  query.exclusions = query.exclusions
    .map((e) => (e.value === from ? { ...e, value: to } : e))
    .filter((e) => {
      const id = `${e.mode}:${e.value}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  return formatQuery(query);
}
