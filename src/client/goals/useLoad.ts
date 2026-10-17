import { useCallback, useEffect, useState } from 'react';

export type Loaded<T> =
  { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; data: T };

/**
 * One read, loaded on mount and whenever `key` or `refresh` changes, plus an explicit `reload`. No polling, no timers.
 *
 * `key` is the resource identity: a different key is a different resource, so a result held for another key is never
 * returned and the caller sees `loading` until the new identity resolves. `refresh` (a parent generation counter) and
 * `reload` re-read the SAME identity and keep the data already shown until the new read settles.
 */
export function useLoad<T>(
  load: () => Promise<T>,
  key: string,
  refresh: number | string = 0,
): { result: Loaded<T>; reload: () => void } {
  const [held, setHeld] = useState<{ key: string; result: Loaded<T> } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(load)
      .then(
        (data) => live && setHeld({ key, result: { state: 'ready', data } }),
        (reason: unknown) =>
          live &&
          setHeld({
            key,
            result: {
              state: 'error',
              message: reason instanceof Error ? reason.message : 'The request failed.',
            },
          }),
      );
    return () => {
      live = false;
    };
  }, [key, tick, refresh]);
  const result: Loaded<T> = held !== null && held.key === key ? held.result : { state: 'loading' };
  return { result, reload: useCallback(() => setTick((value) => value + 1), []) };
}
