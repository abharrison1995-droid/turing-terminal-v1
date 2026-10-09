import { useEffect, useState } from 'react';

export const GOAL_COMPACT_QUERY = '(max-width: 640px)';

/** Presentation only: this matchMedia result never grants or denies server authority. */
export function useCompactViewport(): boolean {
  const [compact, setCompact] = useState(
    () => typeof window !== 'undefined' && Boolean(window.matchMedia?.(GOAL_COMPACT_QUERY).matches),
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      setCompact(false);
      return;
    }
    const query = window.matchMedia(GOAL_COMPACT_QUERY);
    const update = (event: MediaQueryListEvent | MediaQueryList) => setCompact(event.matches);
    update(query);
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  return compact;
}
