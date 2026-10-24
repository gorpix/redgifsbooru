// Tag name forms shared by search, storage and UI.
// key:  "big tits"  — lowercase, single spaces; used for every comparison
// term: "big_tits"  — what users type and what the UI shows (e621 style)

/** Comparison key: NFKC, underscores and hyphens to spaces (RedGifs treats them alike), collapsed whitespace, lowercase. */
export function normalizeTag(value: string): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[_-]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Display/search form: the key with spaces turned into underscores. */
export function toTagTerm(value: string): string {
  return normalizeTag(value).replace(/ /g, '_');
}
