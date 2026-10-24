// Shapes of RedGifs API responses, limited to the fields the booru uses.

export interface GifUrls {
  hd?: string;
  sd?: string;
  silent?: string;
  thumbnail?: string;
  poster?: string;
  [key: string]: string | undefined;
}

export interface Gif {
  id: string;
  userName: string;
  /** Unix seconds. */
  createDate: number;
  views: number | null;
  likes: number;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  /** 1 video, 2 image. */
  type: number;
  tags: string[];
  niches: string[];
  description: string | null;
  avgColor?: string;
  verified: boolean;
  urls: GifUrls;
}

export interface User {
  username: string;
  name?: string | null;
  verified?: boolean;
  [key: string]: unknown;
}

export type SearchOrder = 'trending' | 'latest' | 'top7' | 'top28' | 'score' | 'best' | 'hot';

export interface SearchParams {
  order?: SearchOrder;
  /** g = videos/gifs, i = images. */
  type?: 'g' | 'i';
  count?: number;
  page?: number;
  /** Tag names; sent comma-separated in one `tags` parameter. */
  tags?: string[];
}

/** One server page of search results, with ads removed. */
export interface SearchPage {
  gifs: Gif[];
  page: number;
  pages: number;
  total: number;
  users: User[];
}

/** `/v2/tags/{Name}`: RedGifs' own wiki entry for a tag. */
export interface TagWiki {
  tag: string;
  description: string | null;
  /** Related tag names (about 50), in RedGifs' order. */
  related: string[];
}

/** `/v1/users/{name}`, read defensively: every field may be missing. */
export interface UserProfile {
  username: string;
  name: string | null;
  description: string | null;
  followers: number | null;
  following: number | null;
  /** Number of posts: `publishedGifs` when present, else `gifs`. */
  posts: number | null;
  profileImageUrl: string | null;
  profileUrl: string | null;
  /** Unix seconds. */
  createdAt: number | null;
  verified: boolean;
  /** `socialUrl1..3` that are set. */
  socials: string[];
}

/** One row of `/v2/niches`. */
export interface NicheSummary {
  id: string;
  name: string;
  gifs: number;
  subscribers: number;
  tags: string[];
  thumbnail: string | null;
}

export interface NichesPage {
  page: number;
  pages: number;
  total: number;
  niches: NicheSummary[];
}

/** `/v2/niches/{id}`. */
export interface Niche extends NicheSummary {
  description: string | null;
  cover: string | null;
  owner: string | null;
  /** One text per rule. */
  rules: string[];
}
