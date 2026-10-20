import { useEffect, useRef, useState } from 'react';

/** One looping status animation: six frames, each 24 rows of 24 characters over .obsa. */
export interface MascotAnimation {
  readonly frameMs: number;
  readonly loop: boolean;
  readonly frames: readonly (readonly string[])[];
}

/** The subset of timers playback needs, so tests can drive time by hand. */
export interface MascotClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface MascotPlaybackOptions {
  clock?: MascotClock;
  reducedMotion: boolean;
  /** Defaults to reading document.hidden. */
  isHidden?: () => boolean;
}

const browserClock: MascotClock = {
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

/** Frame index for an elapsed time. Looping animations wrap; one-shot ones hold on their last frame. */
export function frameIndexAt(animation: MascotAnimation, elapsedMs: number): number {
  const count = animation.frames.length;
  const index = Math.floor(Math.max(0, elapsedMs) / animation.frameMs);
  return animation.loop ? index % count : Math.min(index, count - 1);
}

/**
 * The current frame index. Frame 0 under reduced motion, with no timers. Otherwise one timer is pending at a time, one
 * per frame. While the page is hidden no timer is pending and the frame holds. Becoming visible schedules the next frame.
 */
export function useMascotFrame(animation: MascotAnimation, options: MascotPlaybackOptions): number {
  const { reducedMotion } = options;
  const [frame, setFrame] = useState(0);
  // The latest clock and visibility reader, so an inline option object does not restart playback on every render.
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  useEffect(() => {
    if (reducedMotion) return undefined;
    const clock = latest.current.clock ?? browserClock;
    const readHidden = () => (latest.current.isHidden ? latest.current.isHidden() : document.hidden);
    const { frames, frameMs } = animation;
    let index = 0;
    let handle: unknown = undefined;
    let scheduled = false;

    const stop = () => {
      if (scheduled) clock.clearTimeout(handle);
      scheduled = false;
    };
    const schedule = () => {
      handle = clock.setTimeout(tick, frameMs);
      scheduled = true;
    };
    function tick() {
      scheduled = false;
      index = (index + 1) % frames.length;
      setFrame(index);
      schedule();
    }
    const sync = () => {
      if (readHidden()) stop();
      else if (!scheduled) schedule();
    };

    setFrame(0);
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      stop();
    };
  }, [animation, reducedMotion]);

  return reducedMotion ? 0 : frame;
}
