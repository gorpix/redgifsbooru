// Endpoints the booru must never call: view/analytics beacons (calling them
// would inflate view counts) and anything ad-related.
const FORBIDDEN = [
  /^\/v\d+\/metrics(\/|$)/,
  /^\/v\d+\/events(\/|$)/,
  /^\/v\d+\/(ads?|boost(ed)?|promot(ed|ions?))(\/|$|_)/,
];

export const API_ROOT = 'https://api.redgifs.com';

/** True for anything that is not a plain RedGifs API read the booru allows. */
export function isForbiddenUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (parsed.origin !== API_ROOT) return true;
  return FORBIDDEN.some((pattern) => pattern.test(parsed.pathname));
}
