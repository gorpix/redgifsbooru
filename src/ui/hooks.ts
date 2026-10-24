import { useEffect, useState } from 'preact/hooks';

/** Re-renders when `subscribe`'s listener fires; returns a change counter for use as a memo key. */
export function useSubscription(subscribe: (listener: () => void) => () => void): number {
  const [version, setVersion] = useState(0);
  useEffect(() => subscribe(() => setVersion((v) => v + 1)), [subscribe]);
  return version;
}
