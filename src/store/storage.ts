// Shared localStorage helpers: safe reads and writes, plus change notification
// for this tab and (through the window 'storage' event) other tabs.

export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** localStorage, or null when it is missing or blocked. */
export function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readText(key: string, storage: KeyValueStorage | null): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function readJson(key: string, storage: KeyValueStorage | null): unknown {
  const text = readText(key, storage);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Returns false when the write failed. */
export function writeText(key: string, value: string, storage: KeyValueStorage | null): boolean {
  try {
    if (!storage) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function writeJson(key: string, value: unknown, storage: KeyValueStorage | null): boolean {
  return writeText(key, JSON.stringify(value), storage);
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Listeners for a group of storage keys. */
export function createChannel(keys: readonly string[]) {
  const listeners = new Set<() => void>();
  return {
    /** Call after this tab changes one of the keys. */
    notify(): void {
      for (const listener of [...listeners]) {
        try { listener(); } catch { /* a bad listener must not stop the others */ }
      }
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      const target = typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : null;
      const onStorage = (event: StorageEvent) => {
        if (event.key === null || keys.includes(event.key)) listener();
      };
      target?.addEventListener('storage', onStorage);
      return () => {
        listeners.delete(listener);
        target?.removeEventListener('storage', onStorage);
      };
    },
  };
}
