// @vitest-environment jsdom

// UI.6 A2 and A3 (UI6_SCOPE section 1 and 5; UI0 13.4): pure frame index maths and the playback hook. ./playback.ts
// does not exist yet.
//
// Contract assumed for the implementer:
// - frameIndexAt(animation, elapsedMs): number. For a loop, floor(elapsedMs / frameMs) modulo frames.length.
// - useMascotFrame(animation, { clock, reducedMotion, isHidden? }): number, the current frame index.
//   clock is { setTimeout(callback, ms), clearTimeout(handle) }. One timeout is pending at a time, one per frame.
//   isHidden is a () => boolean that defaults to reading document.hidden. While hidden no timer is pending and the frame
//   holds. Visible again resumes playback.
//   reducedMotion true returns frame 0 and schedules no timers.
//
// Every test is RED. Each loads ./playback inside the test, so each reports its own "Cannot find module" failure.
// Time comes only from a manual virtual clock, so no real or fake timers are used.

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

type Animation = Parameters<typeof import('./playback').frameIndexAt>[0];

/** A six-frame loop at the given cadence. Playback reads only frameMs, loop and frames.length. */
const loop = (frameMs: number): Animation => ({
  frameMs,
  loop: true,
  frames: Array.from({ length: 6 }, () => Array.from({ length: 24 }, () => '.'.repeat(24))),
});
const IDLE = loop(300);
const THINKING = loop(150);
const LOADING = loop(150);

interface PendingTimer {
  due: number;
  callback: () => void;
}

/**
 * Virtual time. advance(ms) fires every due callback in order of due time, including callbacks scheduled while firing,
 * then leaves the clock at the target time.
 */
function virtualClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, PendingTimer>();
  const clock = {
    setTimeout(callback: () => void, ms: number) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { due: now + ms, callback });
      return id;
    },
    clearTimeout(handle: unknown) {
      timers.delete(handle as number);
    },
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      let next: [number, PendingTimer] | undefined;
      for (const entry of timers) {
        if (entry[1].due <= target && (!next || entry[1].due < next[1].due)) next = entry;
      }
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].due;
      next[1].callback();
    }
    now = target;
  };
  return { clock, advance, pending: () => timers.size };
}

describe('mascot playback (UI6 A2 and A3)', () => {
  afterEach(() => {
    cleanup();
  });

  // [RED] frameIndexAt steps every 300 ms for idle and wraps back to frame 0 after the sixth frame.
  it('frameIndexAt steps every 300 ms for idle and wraps after the last frame', async () => {
    const { frameIndexAt } = await import('./playback');
    expect(frameIndexAt(IDLE, 0)).toBe(0);
    expect(frameIndexAt(IDLE, 299)).toBe(0);
    expect(frameIndexAt(IDLE, 300)).toBe(1);
    expect(frameIndexAt(IDLE, 1500)).toBe(5);
    expect(frameIndexAt(IDLE, 1800)).toBe(0);
    expect(frameIndexAt(IDLE, 2100)).toBe(1);
  });

  // [RED] thinking and loading step every 150 ms.
  it('frameIndexAt steps every 150 ms for thinking and loading', async () => {
    const { frameIndexAt } = await import('./playback');
    for (const animation of [THINKING, LOADING]) {
      expect(frameIndexAt(animation, 149)).toBe(0);
      expect(frameIndexAt(animation, 150)).toBe(1);
      expect(frameIndexAt(animation, 900)).toBe(0);
    }
  });

  // [RED] the idle hook advances at 300 ms, keeps one timer pending, and wraps to frame 0 after six frames.
  it('useMascotFrame advances idle every 300 ms with one timer pending, and wraps', async () => {
    const { useMascotFrame } = await import('./playback');
    const timers = virtualClock();
    const { result } = renderHook(() =>
      useMascotFrame(IDLE, { clock: timers.clock, reducedMotion: false, isHidden: () => false }),
    );
    expect(result.current).toBe(0);
    expect(timers.pending()).toBe(1);
    for (let step = 1; step <= 6; step += 1) {
      act(() => timers.advance(300));
      expect(result.current).toBe(step % 6);
      expect(timers.pending()).toBe(1);
    }
  });

  // [RED] thinking and loading hooks advance at 150 ms and not before.
  it('useMascotFrame advances thinking and loading every 150 ms', async () => {
    const { useMascotFrame } = await import('./playback');
    for (const animation of [THINKING, LOADING]) {
      const timers = virtualClock();
      const { result, unmount } = renderHook(() =>
        useMascotFrame(animation, { clock: timers.clock, reducedMotion: false, isHidden: () => false }),
      );
      act(() => timers.advance(149));
      expect(result.current).toBe(0);
      act(() => timers.advance(1));
      expect(result.current).toBe(1);
      unmount();
    }
  });

  // [RED] unmounting cancels the pending frame timer through the injected clock.
  it('unmount cancels the pending frame timer', async () => {
    const { useMascotFrame } = await import('./playback');
    const timers = virtualClock();
    const { unmount } = renderHook(() =>
      useMascotFrame(IDLE, { clock: timers.clock, reducedMotion: false, isHidden: () => false }),
    );
    expect(timers.pending()).toBe(1);
    unmount();
    expect(timers.pending()).toBe(0);
  });

  // [RED] while the page is hidden the frame holds and no timer stays pending. Becoming visible resumes playback.
  it('pauses while hidden and resumes when visible again', async () => {
    const { useMascotFrame } = await import('./playback');
    const timers = virtualClock();
    let hidden = false;
    const { result } = renderHook(() =>
      useMascotFrame(IDLE, { clock: timers.clock, reducedMotion: false, isHidden: () => hidden }),
    );
    act(() => timers.advance(300));
    expect(result.current).toBe(1);

    hidden = true;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    act(() => timers.advance(3000));
    expect(result.current).toBe(1);
    expect(timers.pending()).toBe(0);

    hidden = false;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    act(() => timers.advance(300));
    expect(result.current).toBe(2);
  });

  // [RED] with no isHidden option the hook reads document.hidden, so a hidden page schedules nothing.
  it('reads document.hidden when no isHidden option is injected', async () => {
    const { useMascotFrame } = await import('./playback');
    const timers = virtualClock();
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    try {
      const { result } = renderHook(() =>
        useMascotFrame(IDLE, { clock: timers.clock, reducedMotion: false }),
      );
      act(() => timers.advance(900));
      expect(result.current).toBe(0);
      expect(timers.pending()).toBe(0);
    } finally {
      delete (document as { hidden?: boolean }).hidden;
    }
  });

  // [RED] reduced motion shows frame 0 and schedules no timers, however long the clock runs.
  it('under reduced motion returns frame 0 with zero pending timers', async () => {
    const { useMascotFrame } = await import('./playback');
    const timers = virtualClock();
    const { result } = renderHook(() =>
      useMascotFrame(IDLE, { clock: timers.clock, reducedMotion: true, isHidden: () => false }),
    );
    act(() => timers.advance(10_000));
    expect(result.current).toBe(0);
    expect(timers.pending()).toBe(0);
  });
});
