import { useEffect, useRef, useState } from 'react';

/** Why the timer is held. Each source is tracked on its own, so two of them can be active at once. */
type Source = 'hover' | 'pointer' | 'focus' | 'touch';

/** Handlers for the element that carries role="status". Spread them onto that element. */
export interface NoticeHandlers {
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onPointerDown: () => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onFocus: () => void;
  onBlur: () => void;
  onTouchStart: () => void;
  onTouchEnd: () => void;
  onTouchCancel: () => void;
}

const NO_SOURCES: ReadonlySet<Source> = new Set();

/** The phrase that makes a notice a success even when it contains 'before'. Checked first. */
const SUCCESS_PREFIX = /^run preview is ready\b/i;
/** Failure words. A notice that contains one stays until it is dismissed. */
const FAILURE_WORDS = /\b(failed|did not|cannot|can't|stopped|unable|denied|error|rejected|refused)\b/i;

/**
 * Whether a notice reports a failure. It stays on screen until it is dismissed. The original rule (App.tsx) is kept: 'could
 * not', 'before' and 'not available'. A preview-ready notice is a success, so its 'before starting' does not make it an
 * error. It is still an error when it also reports a failure ('could not', 'not available' or a failure word).
 */
export function isErrorNotice(notice: string): boolean {
  const text = notice.toLowerCase();
  const reportsFailure =
    text.includes('could not') || text.includes('not available') || FAILURE_WORDS.test(notice);
  if (SUCCESS_PREFIX.test(notice)) return reportsFailure;
  return reportsFailure || text.includes('before');
}

/** Non-error notices stay for 60 ms a character, at least 6 s and at most 15 s. */
export function noticeDuration(notice: string): number {
  return Math.min(15_000, Math.max(6_000, 60 * notice.length));
}

/**
 * Calls `clear` once, after the notice's duration, unless it is an error notice. Hover, focus, touch and pointer
 * interaction pause the timer; when the last of them ends, the timer restarts from its full duration. A new notice text
 * restarts the timer for that text.
 */
export function useNoticeTimeout(notice: string, clear: () => void): NoticeHandlers {
  const [held, setHeld] = useState<ReadonlySet<Source>>(NO_SOURCES);
  const clearRef = useRef(clear);

  useEffect(() => {
    clearRef.current = clear;
  }, [clear]);

  // A dismissed toast can unmount while a source is still held, and its end event never arrives. Forget the sources.
  useEffect(() => {
    if (!notice) setHeld(NO_SOURCES);
  }, [notice]);

  useEffect(() => {
    if (!notice || isErrorNotice(notice) || held.size > 0) return undefined;
    const timer = setTimeout(() => clearRef.current(), noticeDuration(notice));
    return () => clearTimeout(timer);
  }, [notice, held]);

  const hold = (source: Source) => () =>
    setHeld((current) => {
      if (current.has(source)) return current;
      return new Set(current).add(source);
    });
  /** Ends each listed source that is active. A pointer that leaves, or whose press is cancelled, must not hold the timer. */
  const release =
    (...sources: Source[]) =>
    () =>
      setHeld((current) => {
        if (!sources.some((source) => current.has(source))) return current;
        const next = new Set(current);
        for (const source of sources) next.delete(source);
        return next;
      });

  return {
    onPointerEnter: hold('hover'),
    onPointerLeave: release('hover', 'pointer'),
    onPointerDown: hold('pointer'),
    onPointerUp: release('pointer'),
    onPointerCancel: release('pointer'),
    onFocus: hold('focus'),
    onBlur: release('focus'),
    onTouchStart: hold('touch'),
    onTouchEnd: release('touch'),
    onTouchCancel: release('touch'),
  };
}
