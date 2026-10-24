import { describe, expect, it, vi } from 'vitest';
import { LOW_PAUSED_KEY, RATE_LIMIT_KEY, RequestBudget } from '../src/api/budget';
import { RequestQueue, type Clock } from '../src/api/queue';

/** Sleep advances virtual time immediately. */
function fakeClock(start = 1000): Clock & { t: number } {
  const clock = {
    t: start,
    now: () => clock.t,
    sleep: async (ms: number) => { clock.t += ms; },
  };
  return clock;
}

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
}

describe('RequestQueue', () => {
  it('defaults to one start per second', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const queue = new RequestQueue({ concurrency: 2 });
      const starts: number[] = [];
      const all = Promise.all([1, 2, 3].map(() => queue.run(async () => { starts.push(Date.now()); })));
      await vi.advanceTimersByTimeAsync(3000);
      await all;
      expect(starts).toEqual([0, 1000, 2000]);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('shared budget and stored pauses', () => {
    it('waits for the budget before starting and records each start', async () => {
      const clock = fakeClock(1000);
      const budget = new RequestBudget(fakeStorage());
      for (let i = 0; i < 30; i++) budget.record('high', 1000 - i); // another tab used the whole window
      const queue = new RequestQueue({ concurrency: 1, minIntervalMs: 0, clock, budget });
      let startedAt = 0;
      await queue.run(async () => { startedAt = clock.now(); });
      expect(startedAt).toBe(1000 - 29 + 60_000); // when the oldest start leaves the window
      expect(budget.waitTime('high', startedAt)).toBeGreaterThan(0); // the new start counts too
    });

    it('applies the low-priority budget only to low tasks', async () => {
      const clock = fakeClock(1000);
      const budget = new RequestBudget(fakeStorage());
      for (let i = 0; i < 6; i++) budget.record('low', 1000);
      const queue = new RequestQueue({ concurrency: 2, minIntervalMs: 0, clock, budget });
      let high = 0;
      let low = 0;
      await queue.run(async () => { high = clock.now(); });
      await queue.run(async () => { low = clock.now(); }, { priority: 'low' });
      expect(high).toBe(1000);
      expect(low).toBe(61_000);
    });

    it('honours a rate-limit pause stored by another tab', async () => {
      const clock = fakeClock(1000);
      const storage = fakeStorage({ [RATE_LIMIT_KEY]: '9000' });
      const queue = new RequestQueue({ concurrency: 1, minIntervalMs: 0, clock, storage });
      let startedAt = 0;
      await queue.run(async () => { startedAt = clock.now(); });
      expect(startedAt).toBe(9000);
    });

    it('holds low tasks back during the stored low pause but not high ones', async () => {
      const clock = fakeClock(1000);
      const storage = fakeStorage({ [LOW_PAUSED_KEY]: '50000' });
      const queue = new RequestQueue({ concurrency: 2, minIntervalMs: 0, clock, storage });
      let high = 0;
      let low = 0;
      await queue.run(async () => { high = clock.now(); });
      await queue.run(async () => { low = clock.now(); }, { priority: 'low' });
      expect(high).toBe(1000);
      expect(low).toBe(50_000);
    });

    it('ignores garbage in the stored pause', async () => {
      const clock = fakeClock(1000);
      const queue = new RequestQueue({ concurrency: 1, minIntervalMs: 0, clock, storage: fakeStorage({ [RATE_LIMIT_KEY]: 'soon' }) });
      let startedAt = 0;
      await queue.run(async () => { startedAt = clock.now(); });
      expect(startedAt).toBe(1000);
    });
  });

  it('never runs more than `concurrency` tasks at once', async () => {
    const queue = new RequestQueue({ concurrency: 2, minIntervalMs: 0, clock: fakeClock() });
    let running = 0;
    let peak = 0;
    const gates = Array.from({ length: 5 }, () => deferred());
    const results = gates.map((gate, i) => queue.run(async () => {
      running++;
      peak = Math.max(peak, running);
      await gate.promise;
      running--;
      return i;
    }));
    await flush();
    expect(running).toBe(2);
    expect(queue.activeCount).toBe(2);
    expect(queue.pendingCount).toBe(3);
    for (const gate of gates) {
      gate.resolve();
      await flush();
    }
    expect(await Promise.all(results)).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
    expect(queue.activeCount).toBe(0);
  });

  it('spaces starts by minIntervalMs', async () => {
    // Real timers faked by vitest, so each sleeper wakes at its own virtual time.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const queue = new RequestQueue({ concurrency: 2, minIntervalMs: 250 });
      const starts: number[] = [];
      const all = Promise.all([1, 2, 3, 4].map(() => queue.run(async () => { starts.push(Date.now()); })));
      await vi.advanceTimersByTimeAsync(1000);
      await all;
      expect(starts).toEqual([1000, 1250, 1500, 1750]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pauseUntil holds back starts', async () => {
    const clock = fakeClock(1000);
    const queue = new RequestQueue({ concurrency: 2, minIntervalMs: 0, clock });
    queue.pauseUntil(5000);
    let startedAt = 0;
    await queue.run(async () => { startedAt = clock.now(); });
    expect(startedAt).toBe(5000);
  });

  it('pauseUntil never shortens an existing pause', async () => {
    const clock = fakeClock(0);
    const queue = new RequestQueue({ concurrency: 1, minIntervalMs: 0, clock });
    queue.pauseUntil(5000);
    queue.pauseUntil(2000);
    let startedAt = 0;
    await queue.run(async () => { startedAt = clock.now(); });
    expect(startedAt).toBe(5000);
  });

  it('a rejecting task frees its slot and propagates the error', async () => {
    const queue = new RequestQueue({ concurrency: 1, minIntervalMs: 0, clock: fakeClock() });
    const failing = queue.run(async () => { throw new Error('boom'); });
    const next = queue.run(async () => 'ok');
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
    expect(queue.activeCount).toBe(0);
    expect(queue.pendingCount).toBe(0);
  });

  describe('priority and abort', () => {
    /** One-slot queue whose only slot is held until `release()`. */
    async function blocked() {
      const queue = new RequestQueue({ concurrency: 1, minIntervalMs: 0, clock: fakeClock() });
      const gate = deferred();
      const holder = queue.run(() => gate.promise);
      await flush();
      return { queue, release: async () => { gate.resolve(); await holder; } };
    }

    it('starts waiting high tasks before low ones, in order within a priority', async () => {
      const { queue, release } = await blocked();
      const order: string[] = [];
      const add = (name: string, priority?: 'high' | 'low') =>
        queue.run(async () => { order.push(name); }, { priority });
      const all = [add('low1', 'low'), add('high1', 'high'), add('low2', 'low'), add('high2'), add('low3', 'low')];
      expect(queue.pendingCount).toBe(5);
      await release();
      await Promise.all(all);
      expect(order).toEqual(['high1', 'high2', 'low1', 'low2', 'low3']);
    });

    it('a low task runs at once when nothing else waits', async () => {
      const queue = new RequestQueue({ concurrency: 2, minIntervalMs: 0, clock: fakeClock() });
      await expect(queue.run(async () => 'x', { priority: 'low' })).resolves.toBe('x');
    });

    it('rejects an already-aborted signal without running the task', async () => {
      const queue = new RequestQueue({ concurrency: 1, minIntervalMs: 0, clock: fakeClock() });
      const controller = new AbortController();
      controller.abort();
      const task = vi.fn(async () => 1);
      const err: any = await queue.run(task, { signal: controller.signal }).catch((e) => e);
      expect(err.name).toBe('AbortError');
      expect(task).not.toHaveBeenCalled();
      expect(queue.activeCount).toBe(0);
    });

    it('drops a waiting task as soon as it is aborted and keeps the others', async () => {
      const { queue, release } = await blocked();
      const controller = new AbortController();
      const task = vi.fn(async () => 'aborted');
      const dropped = queue.run(task, { signal: controller.signal, priority: 'low' });
      const kept = queue.run(async () => 'kept');
      expect(queue.pendingCount).toBe(2);
      controller.abort();
      await expect(dropped).rejects.toMatchObject({ name: 'AbortError' });
      expect(queue.pendingCount).toBe(1);
      await release();
      await expect(kept).resolves.toBe('kept');
      expect(task).not.toHaveBeenCalled();
      expect(queue.activeCount).toBe(0);
    });

    it('does not interrupt a task that already started', async () => {
      const queue = new RequestQueue({ concurrency: 1, minIntervalMs: 0, clock: fakeClock() });
      const controller = new AbortController();
      const gate = deferred();
      const run = queue.run(async () => { await gate.promise; return 'done'; }, { signal: controller.signal });
      await flush();
      controller.abort();
      gate.resolve();
      await expect(run).resolves.toBe('done');
    });
  });

  describe('low-priority slot limit', () => {
    it('with concurrency 2, two low tasks submitted first run one at a time', async () => {
      const queue = new RequestQueue({ concurrency: 2, minIntervalMs: 0, clock: fakeClock() });
      const gates = [deferred(), deferred()];
      const started: number[] = [];
      const results = gates.map((gate, i) => queue.run(async () => {
        started.push(i);
        await gate.promise;
        return i;
      }, { priority: 'low' }));
      await flush();
      expect(started).toEqual([0]);
      expect(queue.activeCount).toBe(1);
      expect(queue.pendingCount).toBe(1);
      gates[0].resolve();
      await flush();
      expect(started).toEqual([0, 1]);
      gates[1].resolve();
      expect(await Promise.all(results)).toEqual([0, 1]);
      expect(queue.activeCount).toBe(0);
    });

    it('a high task starts at once while one low task runs', async () => {
      const queue = new RequestQueue({ concurrency: 2, minIntervalMs: 0, clock: fakeClock() });
      const lowGate = deferred();
      const low = queue.run(() => lowGate.promise, { priority: 'low' });
      await flush();
      const high = vi.fn(async () => 'high');
      await expect(queue.run(high)).resolves.toBe('high');
      expect(high).toHaveBeenCalledTimes(1);
      expect(queue.activeCount).toBe(1);
      lowGate.resolve();
      await low;
      expect(queue.activeCount).toBe(0);
    });

    it('still runs every low waiter eventually', async () => {
      const queue = new RequestQueue({ concurrency: 2, minIntervalMs: 0, clock: fakeClock() });
      const names: number[] = [];
      const all = Array.from({ length: 5 }, (_, i) => queue.run(async () => {
        names.push(i);
        return i;
      }, { priority: 'low' }));
      expect(await Promise.all(all)).toEqual([0, 1, 2, 3, 4]);
      expect(names).toEqual([0, 1, 2, 3, 4]);
      expect(queue.activeCount).toBe(0);
      expect(queue.pendingCount).toBe(0);
    });

    it('with concurrency 1, low tasks still run in the single slot', async () => {
      const queue = new RequestQueue({ concurrency: 1, minIntervalMs: 0, clock: fakeClock() });
      const results = await Promise.all([
        queue.run(async () => 'a', { priority: 'low' }),
        queue.run(async () => 'b', { priority: 'low' }),
      ]);
      expect(results).toEqual(['a', 'b']);
      expect(queue.activeCount).toBe(0);
    });
  });
});
