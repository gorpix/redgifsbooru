// Maps a parsed query to the API parameters of the stream to scan.
import type { MergeIndex } from './merges';
import type { MediaType, Query, ServerOrder } from './query';

export function serverParams(
  query: Query,
  canonical?: Map<string, string>,
): { order: ServerOrder; type: MediaType; tags?: string[] } {
  const params: { order: ServerOrder; type: MediaType; tags?: string[] } = {
    order: query.serverOrder,
    type: query.type,
  };
  if (query.required.length > 0) {
    params.tags = query.required.map((key) => canonical?.get(key) ?? key);
  }
  return params;
}

export const MAX_STREAMS = 4;

/**
 * Tag lists of the streams for these required keys: the cartesian product of each key's group
 * (members in popularity order, spelled by `canonicalName`), first key varying slowest, cut off
 * at `maxStreams`. No required keys gives a single empty list.
 */
export function tagStreams(
  required: string[],
  index: MergeIndex,
  canonicalName: (key: string) => string,
  maxStreams: number = MAX_STREAMS,
): string[][] {
  const groups = required.map((key) => index.members(key));
  const out: string[][] = [];
  const walk = (depth: number, picked: string[]) => {
    if (out.length >= maxStreams) return;
    if (depth === groups.length) {
      out.push(picked.map(canonicalName));
      return;
    }
    for (const member of groups[depth]) walk(depth + 1, [...picked, member]);
  };
  walk(0, []);
  return out;
}

/**
 * One `tags` list per stream: the cartesian product of the required tags' groups (members in
 * popularity order, canonical spellings via `canonicalName(key)`), capped at `maxStreams` by keeping
 * combinations in product order (most popular first). No required tags -> [undefined].
 */
export function serverStreams(
  query: Query,
  index: MergeIndex,
  canonicalName: (key: string) => string,
  maxStreams: number = MAX_STREAMS,
): (string[] | undefined)[] {
  if (query.required.length === 0) return [undefined];
  return tagStreams(query.required, index, canonicalName, maxStreams);
}
