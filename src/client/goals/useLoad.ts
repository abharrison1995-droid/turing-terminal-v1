import { useCallback, useEffect, useState } from 'react';

export type Loaded<T> =
  { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; data: T };

/**
 * One read, loaded on mount and whenever `key` changes, plus an explicit `reload`. No polling, no timers: the only
 * triggers are mounting, a key change and the user's refresh action.
 */
export function useLoad<T>(load: () => Promise<T>, key: string): { result: Loaded<T>; reload: () => void } {
  const [result, setResult] = useState<Loaded<T>>({ state: 'loading' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setResult((current) => (current.state === 'ready' ? current : { state: 'loading' }));
    Promise.resolve()
      .then(load)
      .then(
        (data) => live && setResult({ state: 'ready', data }),
        (reason: unknown) =>
          live &&
          setResult({
            state: 'error',
            message: reason instanceof Error ? reason.message : 'The request failed.',
          }),
      );
    return () => {
      live = false;
    };
    // `load` is a fresh closure each render; `key` and `tick` are the only intended triggers.
  }, [key, tick]);
  return { result, reload: useCallback(() => setTick((value) => value + 1), []) };
}
