// Runs API requests at most `concurrency` at a time, spaces their starts by
// `minIntervalMs`, and holds everything back while RedGifs is rate-limiting.

import { LOW_PAUSED_KEY, RATE_LIMIT_KEY, readStoredNumber, type RequestBudget } from './budget';

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface QueueOptions {
  concurrency?: number;
  minIntervalMs?: number;
  clock?: Clock;
  /** Cap on request starts shared by all tabs; none by default. */
  budget?: RequestBudget | null;
  /** Where rate-limit pauses written by other tabs live (localStorage). */
  storage?: Pick<Storage, 'getItem'> | null;
}

export interface RunOptions {
  /** Low tasks start only when no high task is waiting. Default 'high'. */
  priority?: 'high' | 'low';
  /** Aborting before the task starts drops it and rejects with an AbortError. */
  signal?: AbortSignal;
}

type Priority = 'high' | 'low';

interface Waiter {
  /** Hands this waiter the freed slot. */
  grant: () => void;
}

const abortError = () => new DOMException('Aborted', 'AbortError');

export class RequestQueue {
  private readonly concurrency: number;
  private readonly minIntervalMs: number;
  private readonly clock: Clock;
  private readonly budget: RequestBudget | null;
  private readonly storage: Pick<Storage, 'getItem'> | null;
  /** Low tasks may hold at most this many slots, so a high task can always find one. */
  private readonly lowLimit: number;
  private active = 0;
  private activeLow = 0;
  private readonly waitingHigh: Waiter[] = [];
  private readonly waitingLow: Waiter[] = [];
  private nextStartAt = 0;
  private pausedUntil = 0;

  constructor({ concurrency = 2, minIntervalMs = 1000, clock = realClock, budget = null, storage = null }: QueueOptions = {}) {
    this.budget = budget;
    this.storage = storage;
    this.concurrency = concurrency;
    this.minIntervalMs = minIntervalMs;
    this.clock = clock;
    this.lowLimit = concurrency > 1 ? concurrency - 1 : 1;
  }

  get activeCount(): number {
    return this.active;
  }

  get pendingCount(): number {
    return this.waitingHigh.length + this.waitingLow.length;
  }

  /** Holds back every request that has not started yet until `until` (unix ms). */
  pauseUntil(until: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, until);
  }

  /** Counts a slot as taken by a task of this priority. */
  private take(priority: Priority): void {
    this.active += 1;
    if (priority === 'low') this.activeLow += 1;
  }

  /** Takes a slot (already counted in `active` once this resolves), or rejects if aborted while waiting. */
  private acquire(priority: Priority, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    const free = this.active < this.concurrency;
    const takeNow = priority === 'high'
      ? free && this.waitingHigh.length === 0
      : free && this.pendingCount === 0 && this.activeLow < this.lowLimit;
    if (takeNow) {
      this.take(priority);
      return Promise.resolve();
    }
    const list = priority === 'low' ? this.waitingLow : this.waitingHigh;
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const i = list.indexOf(waiter);
        if (i >= 0) list.splice(i, 1);
        reject(abortError());
      };
      const waiter: Waiter = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          this.take(priority);
          resolve();
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      list.push(waiter);
    });
  }

  /**
   * Frees a slot (and the low count, when the finished task was low), then hands free slots
   * to high waiters first, and to low waiters only while fewer than `lowLimit` lows are active.
   */
  private release(priority: Priority): void {
    this.active -= 1;
    if (priority === 'low') this.activeLow -= 1;
    while (this.active < this.concurrency) {
      const high = this.waitingHigh.shift();
      if (high) {
        high.grant();
        continue;
      }
      if (this.activeLow >= this.lowLimit) return;
      const low = this.waitingLow.shift();
      if (!low) return;
      low.grant();
    }
  }

  async run<T>(task: () => Promise<T>, { priority = 'high', signal }: RunOptions = {}): Promise<T> {
    await this.acquire(priority, signal);
    try {
      await this.waitForTurn(priority);
      if (signal?.aborted) throw abortError();
      return await task();
    } finally {
      this.release(priority);
    }
  }

  /**
   * Waits for the throttle interval, any rate-limit pause (this tab's or another tab's),
   * the low-priority pause and the shared request budget, then records the start.
   */
  async waitForTurn(priority: Priority = 'high'): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      let startAt = Math.max(this.nextStartAt, this.pausedUntil, readStoredNumber(this.storage, RATE_LIMIT_KEY));
      if (priority === 'low') startAt = Math.max(startAt, readStoredNumber(this.storage, LOW_PAUSED_KEY));
      if (startAt <= now && this.budget) startAt = now + this.budget.waitTime(priority, now);
      if (startAt <= now) {
        this.nextStartAt = now + this.minIntervalMs;
        this.budget?.record(priority, now);
        return;
      }
      await this.clock.sleep(startAt - now);
    }
  }
}
