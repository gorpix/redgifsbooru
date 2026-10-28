import { useEffect, useState } from 'preact/hooks';

/** Re-renders when `subscribe`'s listener fires; returns a change counter for use as a memo key. */
export function useSubscription(subscribe: (listener: () => void) => () => void): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const unsubscribe = subscribe(() => setVersion((v) => v + 1));
    // Catch a change that happened between the first render and this effect.
    setVersion((v) => v + 1);
    return unsubscribe;
  }, [subscribe]);
  return version;
}
