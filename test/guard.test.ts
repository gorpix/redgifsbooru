import { describe, expect, it } from 'vitest';
import { isForbiddenUrl } from '../src/api/guard';

const api = (path: string) => `https://api.redgifs.com${path}`;

describe('isForbiddenUrl', () => {
  it('allows plain reads', () => {
    for (const p of ['/v2/gifs/search?order=trending', '/v2/auth/temporary', '/v2/gifs/abc?users=yes', '/v2/tags']) {
      expect(isForbiddenUrl(api(p))).toBe(false);
    }
  });

  it('forbids metrics and event beacons', () => {
    for (const p of ['/v2/metrics/gifs/abc', '/v2/metrics', '/v3/metrics/x', '/v2/events/track', '/v2/events']) {
      expect(isForbiddenUrl(api(p))).toBe(true);
    }
  });

  it('forbids ad-ish paths', () => {
    for (const p of ['/v2/ads/list', '/v2/ad/x', '/v2/boosted/gifs', '/v2/boost/x', '/v2/promoted/gifs', '/v2/promotions/a', '/v2/promoted_gifs']) {
      expect(isForbiddenUrl(api(p))).toBe(true);
    }
  });

  it('forbids other hosts and look-alikes', () => {
    expect(isForbiddenUrl('https://www.redgifs.com/v2/gifs/search')).toBe(true);
    expect(isForbiddenUrl('https://evil.example/v2/gifs/search')).toBe(true);
    expect(isForbiddenUrl('https://api.redgifs.com.evil.example/v2/gifs/search')).toBe(true);
    expect(isForbiddenUrl('http://api.redgifs.com/v2/gifs/search')).toBe(true);
  });

  it('forbids garbage', () => {
    for (const u of ['', 'not a url', '/v2/gifs/search', '//']) {
      expect(isForbiddenUrl(u)).toBe(true);
    }
  });
});
