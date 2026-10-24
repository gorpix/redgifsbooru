import { useEffect, useState } from 'preact/hooks';

export type Loaded<T> =
  | { status: 'loading' }
  | { status: 'ok'; value: T }
  | { status: 'error'; error: unknown };

/**
 * Runs `load` whenever `key` changes (aborting the previous run) and returns its outcome. While a
 * new key loads, the result is 'loading' (never the previous key's value). `retry` runs it again.
 */
export function useLoad<T>(key: string, load: (signal: AbortSignal) => Promise<T>): Loaded<T> & { retry(): void } {
  const [state, setState] = useState<{ key: string; result: Loaded<T> } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(
      (value) => { if (!controller.signal.aborted) setState({ key: `${key}|${attempt}`, result: { status: 'ok', value } }); },
      (error) => {
        if (controller.signal.aborted || (error as { name?: string })?.name === 'AbortError') return;
        setState({ key: `${key}|${attempt}`, result: { status: 'error', error } });
      },
    );
    return () => controller.abort();
  }, [key, attempt]);

  const result: Loaded<T> = state && state.key === `${key}|${attempt}` ? state.result : { status: 'loading' };
  return { ...result, retry: () => setAttempt((n) => n + 1) };
}
