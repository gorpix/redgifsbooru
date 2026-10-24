// Pure logic of the search box autocomplete (RedGIFS-X style).
import { resolveAlias } from '../search/aliases';
import type { MergeIndex } from '../search/merges';
import { normalizeTag, toTagTerm } from '../search/tags';

export interface AutocompleteContext {
  /** Start of the token in the input text. */
  start: number;
  /** End of the token (next whitespace after the caret). */
  end: number;
  /** Leading `--`, `-` or `~`, kept when a suggestion is accepted. */
  prefix: string;
  /** Text to look up: underscores as spaces. */
  fragment: string;
}

export const MAX_SUGGESTIONS = 10;

/** The tag being typed at the caret, or null when there is nothing to complete. */
export function autocompleteContext(text: string, caret: number): AutocompleteContext | null {
  const pos = Math.max(0, Math.min(caret, text.length));
  let start = pos;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  let end = pos;
  while (end < text.length && !/\s/.test(text[end])) end++;
  const token = text.slice(start, pos);
  const m = /^(--|-|~)?"?/.exec(token);
  const prefix = m?.[1] ?? '';
  const rest = token.slice(m ? m[0].length : 0);
  if (rest.includes(':')) return null;
  if (rest.replace(/_/g, '').length < 2) return null;
  const fragment = rest.replace(/_/g, ' ').trim();
  if (!fragment) return null;
  return { start, end, prefix, fragment };
}

/** Replaces the token with the accepted tag plus a space; returns the new text and caret. */
export function applySuggestion(text: string, ctx: AutocompleteContext, suggestion: string): { text: string; caret: number } {
  const head = text.slice(0, ctx.start) + ctx.prefix + toTagTerm(suggestion) + ' ';
  return { text: head + text.slice(ctx.end).replace(/^\s+/, ''), caret: head.length };
}

/** Keeps suggestions that contain the fragment, without duplicates, at most `max`. */
export function filterSuggestions<T extends { text: string }>(list: T[], fragment: string, max = MAX_SUGGESTIONS): T[] {
  const needle = normalizeTag(fragment);
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of list) {
    const key = normalizeTag(item.text);
    if (!key.includes(needle) || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * True when the answer for `previous` was complete (RedGifs returned fewer than `max` tags, so
 * nothing was cut off) and `next` is a longer fragment: its suggestions are a local filter of it.
 * The suggest endpoint matches by substring, which is why a longer fragment can only narrow it.
 */
export function canReuseSuggestions(previous: string, previousLength: number, next: string, max = MAX_SUGGESTIONS): boolean {
  const a = normalizeTag(previous);
  const b = normalizeTag(next);
  return previousLength >= 0 && previousLength < max && a.length > 0 && b.length > a.length && b.includes(a);
}

export interface SuggestionRow {
  /** Key to insert when the row is accepted (the canonical tag). */
  insert: string;
  /** Term typed / shown on the left. */
  label: string;
  /** Term the label redirects to (alias or merged tag), shown after an arrow. */
  target?: string;
  /** Undefined when no count is known (not in the API list and not in the tag-count cache). */
  count?: number | undefined;
}

/**
 * e621-style suggestion rows: API tags plus the alias source equal to the fragment. An improper tag
 * (alias source, or a non-canonical member of a merge group) shows `label -> target` and inserts the
 * target only when the fragment is exactly that tag; a partly typed member is a plain row.
 */
export function buildSuggestionRows(args: {
  fragment: string;
  apiSuggestions: ReadonlyArray<{ text: string; count: number }>;
  aliasMap: ReadonlyMap<string, string>;
  mergeIndex: MergeIndex;
  /** Fallback count for a tag key (e.g. the tag-count cache); null/undefined = unknown. */
  countOf?: (key: string) => number | null | undefined;
  limit?: number;
}): SuggestionRow[] {
  const { fragment, apiSuggestions, aliasMap, mergeIndex, countOf, limit = MAX_SUGGESTIONS } = args;
  const needle = normalizeTag(fragment);
  if (!needle) return [];

  const counts = new Map<string, number>();
  for (const s of apiSuggestions) {
    const key = normalizeTag(s.text);
    if (key && !counts.has(key)) counts.set(key, s.count);
  }
  /** Sum of the counts of the group members present in the API list, or null when none is. */
  const groupSum = (canonical: string): number | null => {
    let sum = 0;
    let found = false;
    for (const m of mergeIndex.members(canonical)) {
      const c = counts.get(m);
      if (c !== undefined) { sum += c; found = true; }
    }
    return found ? sum : null;
  };

  /** Group sum from the API list, else from countOf over the members; undefined when unknown. */
  const groupCount = (canonical: string): number | undefined => {
    const fromApi = groupSum(canonical);
    if (fromApi !== null) return fromApi;
    if (!countOf) return undefined;
    let sum = 0;
    let found = false;
    for (const m of mergeIndex.members(canonical)) {
      const c = countOf(m);
      if (typeof c === 'number') { sum += c; found = true; }
    }
    return found ? sum : undefined;
  };

  const rows: SuggestionRow[] = [];
  const seen = new Set<string>();
  const push = (row: SuggestionRow) => {
    if (seen.has(row.label)) return;
    seen.add(row.label);
    rows.push(row);
  };

  for (const source of aliasMap.keys()) {
    if (source !== needle) continue; // redirects are shown only once the alias is typed completely
    const insert = mergeIndex.canonical(resolveAlias(source, aliasMap));
    if (insert === source) continue;
    push({ label: toTagTerm(source), target: toTagTerm(insert), insert, count: groupCount(insert) });
  }

  for (const s of apiSuggestions) {
    const key = normalizeTag(s.text);
    if (!key) continue;
    const canonical = mergeIndex.canonical(key);
    if (canonical !== key && key === needle) {
      push({ label: toTagTerm(key), target: toTagTerm(canonical), insert: canonical, count: groupSum(canonical) ?? s.count });
    } else if (canonical !== key) {
      push({ label: toTagTerm(key), insert: key, count: s.count }); // merged member, not typed completely: plain row
    } else {
      push({ label: toTagTerm(key), insert: key, count: groupSum(key) ?? s.count });
    }
  }

  const starts = (row: SuggestionRow) => (normalizeTag(row.label).startsWith(needle) ? 0 : 1);
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => starts(a.row) - starts(b.row) || (b.row.count ?? -1) - (a.row.count ?? -1) || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.row);
}
