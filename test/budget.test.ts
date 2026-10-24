import { describe, expect, it } from 'vitest';
import { LOW_PAUSED_KEY, REQUEST_LOG_KEY, RequestBudget, readStoredNumber, writeStoredMax } from '../src/api/budget';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
  };
}

describe('RequestBudget', () => {
  it('allows starts while under the total limit', () => {
    const budget = new RequestBudget(fakeStorage());
    for (let i = 0; i < 29; i++) budget.record('high', 1000 + i);
    expect(budget.waitTime('high', 2000)).toBe(0);
  });

  it('holds the 31st start until the oldest one leaves the 60 s window', () => {
    const budget = new RequestBudget(fakeStorage());
    for (let i = 0; i < 30; i++) budget.record('high', 1000 + i * 10);
    expect(budget.waitTime('high', 2000)).toBe(1000 + 60_000 - 2000);
    expect(budget.waitTime('high', 1000 + 60_000)).toBe(0); // the first start is exactly 60 s old: out
  });

  it('prunes entries older than 60 s from storage when recording', () => {
    const storage = fakeStorage();
    const budget = new RequestBudget(storage);
    budget.record('high', 0);
    budget.record('high', 70_000);
    expect(JSON.parse(storage.data.get(REQUEST_LOG_KEY)!)).toEqual([[70_000, 'h']]);
  });

  it('limits low-priority starts to 6 per window, and counts them toward the total', () => {
    const budget = new RequestBudget(fakeStorage());
    for (let i = 0; i < 6; i++) budget.record('low', 1000 + i * 100);
    expect(budget.waitTime('low', 2000)).toBe(1000 + 60_000 - 2000);
    expect(budget.waitTime('high', 2000)).toBe(0);
    // Low starts also use up the total of 30.
    for (let i = 0; i < 24; i++) budget.record('high', 3000 + i);
    expect(budget.waitTime('high', 4000)).toBe(1000 + 60_000 - 4000);
  });

  it('high starts do not count toward the low limit', () => {
    const budget = new RequestBudget(fakeStorage());
    for (let i = 0; i < 10; i++) budget.record('high', 1000 + i);
    expect(budget.waitTime('low', 2000)).toBe(0);
  });

  it('shares the log between tabs through storage', () => {
    const storage = fakeStorage();
    const a = new RequestBudget(storage);
    const b = new RequestBudget(storage);
    for (let i = 0; i < 15; i++) a.record('high', 1000 + i);
    for (let i = 0; i < 15; i++) b.record('high', 2000 + i);
    expect(a.waitTime('high', 3000)).toBe(1000 + 60_000 - 3000);
    expect(b.waitTime('high', 3000)).toBe(1000 + 60_000 - 3000);
  });

  it('tolerates garbage in storage and falls back to its own log', () => {
    for (const garbage of ['not json', '{"a":1}', '42', '[1,2,"x",[5],[null,"h"]]']) {
      const budget = new RequestBudget(fakeStorage({ [REQUEST_LOG_KEY]: garbage }));
      expect(budget.waitTime('high', 1000)).toBe(0);
      budget.record('high', 1000);
      expect(budget.waitTime('high', 1000)).toBe(0);
    }
    const budget = new RequestBudget(fakeStorage({ [REQUEST_LOG_KEY]: 'not json' }));
    for (let i = 0; i < 30; i++) budget.record('high', 1000 + i);
    expect(budget.waitTime('high', 2000)).toBeGreaterThan(0);
  });

  it('keeps counting in memory when storage throws', () => {
    const broken = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    const budget = new RequestBudget(broken);
    for (let i = 0; i < 30; i++) budget.record('high', 1000 + i);
    expect(budget.waitTime('high', 2000)).toBe(1000 + 60_000 - 2000);
  });

  it('works without storage', () => {
    const budget = new RequestBudget(null);
    for (let i = 0; i < 6; i++) budget.record('low', 1000);
    expect(budget.waitTime('low', 1000)).toBe(60_000);
  });
});

describe('stored numbers', () => {
  it('reads 0 for missing, garbage and throwing storage', () => {
    expect(readStoredNumber(fakeStorage(), 'k')).toBe(0);
    expect(readStoredNumber(fakeStorage({ k: 'abc' }), 'k')).toBe(0);
    expect(readStoredNumber({ getItem: () => { throw new Error('x'); } }, 'k')).toBe(0);
    expect(readStoredNumber(fakeStorage({ k: '123' }), 'k')).toBe(123);
  });

  it('writeStoredMax never shortens a stored value', () => {
    const storage = fakeStorage();
    writeStoredMax(storage, LOW_PAUSED_KEY, 500);
    writeStoredMax(storage, LOW_PAUSED_KEY, 300);
    expect(storage.data.get(LOW_PAUSED_KEY)).toBe('500');
    writeStoredMax(storage, LOW_PAUSED_KEY, 900);
    expect(storage.data.get(LOW_PAUSED_KEY)).toBe('900');
  });
});
