// Gender implications: a tag can imply that a post shows a female, a male and/or a trans person.
// Used by the "hide posts without a gender tag" filter. Pure; storage lives in store/implications.ts.
import type { MergeIndex } from './merges';
import { normalizeTag } from './tags';

export type Gender = 'female' | 'male' | 'trans';
export const GENDERS: readonly Gender[] = ['female', 'male', 'trans'];

/** tag key -> implied genders (an empty list = implies nothing). */
export type ImplicationMap = ReadonlyMap<string, readonly Gender[]>;

export interface UserImplication {
  tag: string;
  /** Empty = `none`: removes the built-in for that tag. */
  genders: Gender[];
}

const SEPARATOR_RE = /^(.*?)\s*(?:->|=>)\s*(.*)$/;

function parseGenders(text: string): Gender[] | null {
  const words = text.split(/[,\s]+/).map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (words.length === 0) return null;
  if (words.includes('none')) return words.every((w) => w === 'none') ? [] : null;
  const out: Gender[] = [];
  for (const w of words) {
    if (!(GENDERS as readonly string[]).includes(w)) return null;
    if (!out.includes(w as Gender)) out.push(w as Gender);
  }
  return out;
}

/** `tag -> female, male` per line; `#` comments; invalid lines are skipped. A later line for a tag wins. */
export function parseImplicationText(text: string): UserImplication[] {
  const byTag = new Map<string, Gender[]>();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = SEPARATOR_RE.exec(trimmed);
    if (!m) continue;
    const tag = normalizeTag(m[1]);
    const genders = parseGenders(m[2]);
    if (!tag || !genders) continue;
    byTag.set(tag, genders);
  }
  return [...byTag].map(([tag, genders]) => ({ tag, genders }));
}

/** User entries override built-ins for the same tag; `none` removes the tag. */
export function buildImplicationMap(
  builtin: Readonly<Record<string, readonly Gender[]>>,
  user: ReadonlyArray<UserImplication>,
): Map<string, readonly Gender[]> {
  const map = new Map<string, readonly Gender[]>();
  for (const [tag, genders] of Object.entries(builtin)) {
    const key = normalizeTag(tag);
    if (key && genders.length > 0) map.set(key, genders);
  }
  for (const { tag, genders } of user) {
    if (genders.length === 0) map.delete(tag);
    else map.set(tag, genders);
  }
  return map;
}

/** RedGifs' `sexuality` values, used only for posts without tags. */
const SEXUALITY_GENDERS: Readonly<Record<string, readonly Gender[]>> = {
  lesbian: ['female'],
  gay: ['male'], // RedGifs files solo male content under gay
  straight: ['female', 'male'],
  bisexual: ['female', 'male'],
  trans: ['trans'],
};

/**
 * The genders a post shows. With tags: the union of what its tags imply (each tag is also looked
 * up by its merge-canonical key). Without tags (missing or empty): derived from `sexuality`.
 * `tags` and `sexuality` are read defensively; non-strings are ignored.
 */
export function genderOf(
  tags: unknown,
  sexuality: unknown,
  implications: ImplicationMap,
  mergeIndex?: MergeIndex,
): Set<Gender> {
  const out = new Set<Gender>();
  const keys = Array.isArray(tags)
    ? tags.filter((t): t is string => typeof t === 'string').map(normalizeTag).filter(Boolean)
    : [];
  if (keys.length > 0) {
    for (const key of keys) {
      for (const k of mergeIndex ? [key, mergeIndex.canonical(key)] : [key]) {
        for (const g of implications.get(k) ?? []) out.add(g);
      }
    }
    return out;
  }
  if (Array.isArray(sexuality)) {
    for (const s of sexuality) {
      if (typeof s !== 'string') continue;
      for (const g of SEXUALITY_GENDERS[s.trim().toLowerCase()] ?? []) out.add(g);
    }
  }
  return out;
}

/** Stable text for an implication map (for hashing into a filler id). */
export function implicationSignature(map: ImplicationMap): string {
  return [...map].map(([tag, genders]) => `${tag}>${[...genders].sort().join('+')}`).sort().join(';');
}
