import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claimPreview, PREVIEW_DELAY_MS, previewSrc, releasePreview, schedulePreview } from '../src/ui/hoverPreview';
import { hiddenByFiltersMessage } from '../src/ui/postsHelpers';

const urls = (o: object) => o as never;

describe('previewSrc', () => {
  it('prefers the silent rendition, falls back to sd, and skips images', () => {
    expect(previewSrc({ type: 1, urls: urls({ silent: 's.mp4', sd: 'sd.mp4' }) })).toBe('s.mp4');
    expect(previewSrc({ type: 1, urls: urls({ sd: 'sd.mp4' }) })).toBe('sd.mp4');
    expect(previewSrc({ type: 1, urls: urls({}) })).toBeUndefined();
    expect(previewSrc({ type: 2, urls: urls({ sd: 'sd.jpg' }) })).toBeUndefined();
  });
});

describe('schedulePreview', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('starts only after the delay, and cancelling earlier starts nothing', () => {
    const start = vi.fn(() => () => undefined);
    const cancel = schedulePreview(start);
    vi.advanceTimersByTime(PREVIEW_DELAY_MS - 1);
    cancel();
    vi.advanceTimersByTime(1000);
    expect(start).not.toHaveBeenCalled();
  });

  it('stops the preview on cancel, and a new preview stops the previous one', () => {
    const stopA = vi.fn();
    const stopB = vi.fn();
    const cancelA = schedulePreview(() => stopA);
    vi.advanceTimersByTime(PREVIEW_DELAY_MS);
    const cancelB = schedulePreview(() => stopB);
    vi.advanceTimersByTime(PREVIEW_DELAY_MS);
    expect(stopA).toHaveBeenCalledTimes(1);
    expect(stopB).not.toHaveBeenCalled();
    cancelB();
    expect(stopB).toHaveBeenCalledTimes(1);
    cancelA();
  });

  it('claimPreview / releasePreview', () => {
    const one = vi.fn();
    const two = vi.fn();
    claimPreview(one);
    claimPreview(two);
    expect(one).toHaveBeenCalledTimes(1);
    releasePreview(two);
    claimPreview(one);
    expect(two).not.toHaveBeenCalled();
    releasePreview(one);
  });
});

describe('hiddenByFiltersMessage', () => {
  it('lists the rejected counts and leaves out empty parts', () => {
    expect(hiddenByFiltersMessage({ blacklist: 8, untagged: 3, orientation: 1 }))
      .toBe('All 12 posts here are hidden by your filters (blacklist: 8, untagged: 3, Show: 1).');
    expect(hiddenByFiltersMessage({ blacklist: 1 })).toBe('All 1 post here is hidden by your filters (blacklist: 1).');
  });
  it('is null when nothing was rejected', () => {
    expect(hiddenByFiltersMessage({})).toBeNull();
  });
});
