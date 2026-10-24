import { describe, expect, it } from 'vitest';
import { formatCount, formatDuration, tagToken } from '../src/ui/format';

describe('tagToken', () => {
  it('lowercases a single word', () => {
    expect(tagToken('Blonde')).toBe('blonde');
  });

  it('joins words with underscores and collapses whitespace runs', () => {
    expect(tagToken('Big  Tits ')).toBe('big_tits');
    expect(tagToken('Big Tits')).toBe('big_tits');
  });

  it('treats tabs and newlines as whitespace', () => {
    expect(tagToken('  Big\t\nTits  ')).toBe('big_tits');
  });

  it('returns an empty string for blank input', () => {
    expect(tagToken('   ')).toBe('');
    expect(tagToken('')).toBe('');
  });
});

describe('formatCount', () => {
  it('shows a dash for null or NaN', () => {
    expect(formatCount(null)).toBe('–');
    expect(formatCount(Number.NaN)).toBe('–');
  });

  it('shows numbers under 1000 as-is', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
  });

  it('abbreviates thousands with one decimal and a k suffix', () => {
    expect(formatCount(1000)).toBe('1.0k');
    expect(formatCount(1234)).toBe('1.2k');
    expect(formatCount(999_949)).toBe('999.9k');
  });

  it('abbreviates millions with one decimal and an M suffix', () => {
    expect(formatCount(999_950)).toBe('1.0M');
    expect(formatCount(1_250_000)).toBe('1.3M');
  });
});

describe('formatDuration', () => {
  it('formats seconds as m:ss', () => {
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(59)).toBe('0:59');
  });

  it('rounds to the nearest second', () => {
    expect(formatDuration(59.4)).toBe('0:59');
    expect(formatDuration(59.6)).toBe('1:00');
  });

  it('clamps negative and missing values to zero', () => {
    expect(formatDuration(-5)).toBe('0:00');
    expect(formatDuration(Number.NaN)).toBe('0:00');
  });

  it('keeps counting minutes past one hour', () => {
    expect(formatDuration(3600)).toBe('60:00');
  });
});
