import { ORIENTATION_CHOICES, type OrientationChoice } from '../search/implications';
import { createChannel, defaultStorage, readJson, writeJson, type KeyValueStorage } from './storage';

export interface Settings {
  postsPerPage: number;
  blacklistEnabled: boolean;
  /** Keep the related rows on screen under the media (limits the media height). */
  showRelatedBelow: boolean;
  /** Keep the RedGifs login fresh in the background (refresh the token before it expires). */
  keepLoggedIn: boolean;
  /** Hide posts that have no tags. */
  hideUntagged: boolean;
  /** Show only this orientation (see orientationOf in search/implications.ts). */
  orientation: OrientationChoice;
}

export const SETTINGS_KEY = 'rgb:settings';
export const DEFAULT_SETTINGS: Settings = { postsPerPage: 75, blacklistEnabled: true, showRelatedBelow: false, keepLoggedIn: true, hideUntagged: false, orientation: 'any' };

const channel = createChannel([SETTINGS_KEY]);

function sanitize(raw: unknown): Settings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const per = Number(r.postsPerPage);
  return {
    postsPerPage: Number.isFinite(per) && per >= 1 ? Math.min(500, Math.round(per)) : DEFAULT_SETTINGS.postsPerPage,
    blacklistEnabled: typeof r.blacklistEnabled === 'boolean' ? r.blacklistEnabled : DEFAULT_SETTINGS.blacklistEnabled,
    showRelatedBelow: typeof r.showRelatedBelow === 'boolean' ? r.showRelatedBelow : DEFAULT_SETTINGS.showRelatedBelow,
    keepLoggedIn: typeof r.keepLoggedIn === 'boolean' ? r.keepLoggedIn : DEFAULT_SETTINGS.keepLoggedIn,
    hideUntagged: typeof r.hideUntagged === 'boolean' ? r.hideUntagged : DEFAULT_SETTINGS.hideUntagged,
    orientation: ORIENTATION_CHOICES.includes(r.orientation as OrientationChoice) ? (r.orientation as OrientationChoice) : DEFAULT_SETTINGS.orientation,
  };
}

export function getSettings(storage: KeyValueStorage | null = defaultStorage()): Settings {
  return sanitize(readJson(SETTINGS_KEY, storage));
}

export function updateSettings(patch: Partial<Settings>, storage: KeyValueStorage | null = defaultStorage()): Settings {
  const next = sanitize({ ...getSettings(storage), ...patch });
  writeJson(SETTINGS_KEY, next, storage);
  channel.notify();
  return next;
}

export const subscribeSettings = channel.subscribe;
