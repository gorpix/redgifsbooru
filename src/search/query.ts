// Query language: parsing, canonical formatting and meta filters.
import { normalizeTag, toTagTerm } from './tags';

export type ServerOrder = 'trending' | 'latest' | 'top7' | 'top28';
export type PageSort =
  | 'views-desc'
  | 'views-asc'
  | 'score-desc'
  | 'score-asc'
  | 'favs-desc'
  | 'favs-asc'
  | 'date-asc';
export type MediaType = 'g' | 'i';
export interface Exclusion {
  mode: 'exact' | 'partial';
  /** Normalized key. */
  value: string;
}
export type MetaField = 'views' | 'favs' | 'score' | 'age' | 'date';
export interface MetaFilter {
  field: MetaField;
  kind: 'number' | 'age' | 'date';
  min: number;
  max: number;
  minInclusive: boolean;
  maxInclusive: boolean;
  label: string;
}
export interface Query {
  required: string[];
  any: string[];
  exclusions: Exclusion[];
  meta: MetaFilter[];
  serverOrder: ServerOrder;
  pageSort: PageSort | null;
  type: MediaType;
}

const TOKEN_RE = /(--|-|~)?(?:"([^"]+)"|([^\s"]+))/g;
const META_RE = /^(views|favs|favorites|likes|score|date|age):(.+)$/i;
const NUMBER_RE = /^(\d+(?:\.\d+)?)([km]?)$/i;
const AGE_RE = /^(\d+(?:\.\d+)?)(h|d|w|mo|y)$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY = 86400;

const AGE_UNITS: Record<string, number> = {
  h: 3600,
  d: DAY,
  w: 604800,
  mo: 2592000,
  y: 31536000,
};

const SERVER_ORDERS: Record<string, ServerOrder> = {
  trending: 'trending',
  latest: 'latest',
  new: 'latest',
  newest: 'latest',
  date: 'latest',
  recent: 'latest',
  top7: 'top7',
  week: 'top7',
  top28: 'top28',
  month: 'top28',
};

const PAGE_SORTS: Record<string, PageSort> = {
  views: 'views-desc',
  views_desc: 'views-desc',
  views_asc: 'views-asc',
  score: 'score-desc',
  score_desc: 'score-desc',
  score_asc: 'score-asc',
  favs: 'favs-desc',
  favs_desc: 'favs-desc',
  likes: 'favs-desc',
  favs_asc: 'favs-asc',
  date_asc: 'date-asc',
  old: 'date-asc',
  oldest: 'date-asc',
};

/** First alias of each page sort, as printed by formatQuery. */
const PAGE_SORT_NAMES: Record<PageSort, string> = {
  'views-desc': 'views',
  'views-asc': 'views_asc',
  'score-desc': 'score',
  'score-asc': 'score_asc',
  'favs-desc': 'favs',
  'favs-asc': 'favs_asc',
  'date-asc': 'date_asc',
};

const TYPES: Record<string, MediaType> = {
  video: 'g',
  gif: 'g',
  g: 'g',
  image: 'i',
  images: 'i',
  i: 'i',
};

interface Side {
  kind: 'number' | 'age' | 'date';
  value: number;
}

function parseNumber(text: string): Side | null {
  const m = NUMBER_RE.exec(text);
  if (!m) return null;
  const suffix = m[2].toLowerCase();
  const mult = suffix === 'k' ? 1e3 : suffix === 'm' ? 1e6 : 1;
  return { kind: 'number', value: parseFloat(m[1]) * mult };
}

function parseAge(text: string): Side | null {
  const m = AGE_RE.exec(text);
  if (!m) return null;
  return { kind: 'age', value: parseFloat(m[1]) * AGE_UNITS[m[2].toLowerCase()] };
}

function parseDate(text: string): Side | null {
  const m = DATE_RE.exec(text);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(y, mo - 1, d);
  // Reject impossible dates such as 2026-02-31 (they roll over).
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return { kind: 'date', value: Math.floor(date.getTime() / 1000) };
}

/** Parses one side of a value for the given field; null when invalid for it. */
function parseSide(field: MetaField, text: string): Side | null {
  if (field === 'age') return parseAge(text);
  if (field === 'date') return parseDate(text) ?? parseAge(text);
  return parseNumber(text);
}

export function parseMetaFilter(token: string): MetaFilter | null {
  const m = META_RE.exec(token.trim());
  if (!m) return null;
  const typed = m[1].toLowerCase();
  const raw = m[2];
  const field: MetaField = typed === 'favorites' || typed === 'likes' ? 'favs' : (typed as MetaField);
  const label = `${typed}:${raw.toLowerCase()}`;
  const make = (
    kind: MetaFilter['kind'],
    min: number,
    max: number,
    minInclusive: boolean,
    maxInclusive: boolean,
  ): MetaFilter => ({ field, kind, min, max, minInclusive, maxInclusive, label });

  const rangeAt = raw.indexOf('..');
  if (rangeAt >= 0) {
    const left = raw.slice(0, rangeAt);
    const right = raw.slice(rangeAt + 2);
    if (!left && !right) return null;
    const a = left ? parseSide(field, left) : null;
    const b = right ? parseSide(field, right) : null;
    if ((left && !a) || (right && !b)) return null;
    if (a && b && a.kind !== b.kind) return null;
    const kind = (a ?? b)!.kind;
    return make(kind, a ? a.value : -Infinity, b ? b.value : Infinity, true, true);
  }

  const om = /^(>=|<=|>|<)?(.*)$/.exec(raw)!;
  const op = om[1] ?? '';
  const side = parseSide(field, om[2]);
  if (!side) return null;
  const v = side.value;
  switch (op) {
    case '>':
      return make(side.kind, v, Infinity, false, false);
    case '>=':
      return make(side.kind, v, Infinity, true, false);
    case '<':
      return make(side.kind, -Infinity, v, false, false);
    case '<=':
      return make(side.kind, -Infinity, v, false, true);
    default:
      if (side.kind === 'age') return make('age', 0, v, true, true);
      if (side.kind === 'date') return make('date', v, v + DAY, true, false);
      return make('number', v, v, true, true);
  }
}

export function parseQuery(text: string): Query {
  const query: Query = {
    required: [],
    any: [],
    exclusions: [],
    meta: [],
    serverOrder: 'trending',
    pageSort: null,
    type: 'g',
  };
  const exclusionKeys = new Set<string>();
  const metaLabels = new Set<string>();

  for (const m of String(text ?? '').matchAll(TOKEN_RE)) {
    const prefix = m[1] ?? '';
    const quoted = m[2] !== undefined;
    const raw = m[2] ?? m[3];

    // Directives are recognized only for bare, unquoted, unprefixed tokens.
    if (!prefix && !quoted) {
      const order = /^order:(.+)$/i.exec(raw);
      if (order) {
        const name = order[1].toLowerCase();
        if (SERVER_ORDERS[name]) {
          query.serverOrder = SERVER_ORDERS[name];
          continue;
        }
        if (PAGE_SORTS[name]) {
          query.pageSort = PAGE_SORTS[name];
          continue;
        }
      }
      const type = /^type:(.+)$/i.exec(raw);
      if (type && TYPES[type[1].toLowerCase()]) {
        query.type = TYPES[type[1].toLowerCase()];
        continue;
      }
      const meta = parseMetaFilter(raw);
      if (meta) {
        if (!metaLabels.has(meta.label)) {
          metaLabels.add(meta.label);
          query.meta.push(meta);
        }
        continue;
      }
    }

    const value = normalizeTag(raw);
    if (!value) continue;
    if (prefix === '--' || prefix === '-') {
      const mode = prefix === '--' ? 'partial' : 'exact';
      const key = `${mode}:${value}`;
      if (!exclusionKeys.has(key)) {
        exclusionKeys.add(key);
        query.exclusions.push({ mode, value });
      }
    } else {
      const list = prefix === '~' ? query.any : query.required;
      if (!list.includes(value)) list.push(value);
    }
  }
  return query;
}

function format(query: Query, sorted: boolean): string {
  const arrange = (list: string[]) => (sorted ? [...list].sort() : list);
  const parts: string[] = [];
  parts.push(...arrange(query.required.map(toTagTerm)));
  parts.push(
    ...arrange(query.exclusions.map((e) => `${e.mode === 'partial' ? '--' : '-'}${toTagTerm(e.value)}`)),
  );
  parts.push(...arrange(query.any.map((v) => `~${toTagTerm(v)}`)));
  parts.push(...arrange(query.meta.map((f) => f.label)));
  if (query.type === 'i') parts.push('type:image');
  if (query.serverOrder !== 'trending') parts.push(`order:${query.serverOrder}`);
  if (query.pageSort) parts.push(`order:${PAGE_SORT_NAMES[query.pageSort]}`);
  return parts.join(' ');
}

export function formatQuery(query: Query): string {
  return format(query, false);
}

export function queryKey(query: Query): string {
  return format(query, true);
}
