// Defensive readers for the phase 4 endpoints: RedGifs' shapes are not documented, so every field
// may be missing or of another type, and nothing here throws.
import type { Niche, NicheSummary, NichesPage, TagWiki, UserProfile } from './types';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : []);

export function readTagWiki(data: unknown, fallbackName: string): TagWiki {
  const o = isObj(data) ? data : {};
  return { tag: str(o.tag) ?? fallbackName, description: str(o.description), related: strings(o.related) };
}

export function readUserProfile(data: unknown, fallbackName: string): UserProfile {
  const root = isObj(data) ? data : {};
  const o = isObj(root.user) ? root.user : root;
  const created = num(o.creationtime ?? o.creationTime);
  return {
    username: str(o.username) ?? str(o.name) ?? fallbackName,
    name: str(o.name),
    description: str(o.description),
    followers: num(o.followers),
    following: num(o.following),
    posts: num(o.publishedGifs) ?? num(o.gifs),
    profileImageUrl: str(o.profileImageUrl),
    profileUrl: str(o.profileUrl),
    // Seconds; tolerate milliseconds.
    createdAt: created === null ? null : created > 1e12 ? Math.floor(created / 1000) : created,
    verified: o.verified === true,
    socials: [o.socialUrl1, o.socialUrl2, o.socialUrl3].map(str).filter((s): s is string => s !== null),
  };
}

export function readNicheSummary(data: unknown): NicheSummary | null {
  if (!isObj(data)) return null;
  const id = str(data.id);
  if (!id) return null;
  return {
    id,
    name: str(data.name) ?? id,
    gifs: num(data.gifs) ?? 0,
    subscribers: num(data.subscribers) ?? 0,
    tags: strings(data.tags),
    thumbnail: str(data.thumbnail),
  };
}

export function readNichesPage(data: unknown, fallbackPage: number): NichesPage {
  const o = isObj(data) ? data : {};
  const list = Array.isArray(o.niches) ? o.niches : [];
  return {
    page: num(o.page) ?? fallbackPage,
    pages: num(o.pages) ?? 0,
    total: num(o.total) ?? 0,
    niches: list.map(readNicheSummary).filter((n): n is NicheSummary => n !== null),
  };
}

/** One text per rule, whether RedGifs sends a string, a list of strings or a list of objects. */
export function readRules(raw: unknown): string[] {
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/\r?\n/) : [];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      if (item.trim()) out.push(item.trim());
    } else if (isObj(item)) {
      const title = str(item.title) ?? str(item.name) ?? str(item.rule);
      const body = str(item.description) ?? str(item.text) ?? str(item.body);
      const text = title && body && title !== body ? `${title}: ${body}` : (title ?? body);
      if (text) out.push(text);
    }
  }
  return out;
}

export function readNiche(data: unknown): Niche | null {
  const root = isObj(data) ? data : {};
  const o = isObj(root.niche) ? root.niche : null;
  if (!o) return null;
  const summary = readNicheSummary(o);
  if (!summary) return null;
  const owner = isObj(o.owner) ? (str(o.owner.username) ?? str(o.owner.name)) : str(o.owner);
  return {
    ...summary,
    description: str(o.description),
    cover: str(o.cover),
    owner,
    rules: readRules(o.rules),
  };
}
