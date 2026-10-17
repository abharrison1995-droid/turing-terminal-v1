// @vitest-environment jsdom

// UI.5 hook tests for the toast auto-dismiss (UI5_SCOPE section 2, "Toast auto-dismiss"; matrix M4). Fake timers only.
//
// API under test, src/client/useNoticeTimeout.ts (not written yet):
//   useNoticeTimeout(notice: string, clear: () => void): NoticeHandlers
//   - An empty notice starts no timer.
//   - An error-classified notice never clears. The classification is App.tsx's existing rule: the lower-cased text includes
//     'could not', 'before' or 'not available'.
//   - Any other notice calls clear once, after min(15000, max(6000, 60 * notice.length)) ms.
//   - Interaction pauses the timer. Each source is tracked on its own: 'hover' (pointerenter, pointerleave), 'pointer'
//     (pointerdown, pointerup), 'focus' (focus, blur) and 'touch' (touchstart, touchend). The timer runs only while no
//     source is active.
//   - When the last source ends, the timer restarts from its full duration (pauses and resets).
//   - A new notice text restarts the timer for that text.
//   - NoticeHandlers = { onPointerEnter, onPointerLeave, onPointerDown, onPointerUp, onFocus, onBlur, onTouchStart,
//     onTouchEnd }, spread onto the element that carries role="status".
// Every test is RED until the module exists: the import below fails, so the file fails as a whole with a module-resolution
// error. The button, role="status" and setNotice text stay in App.tsx and are not tested here.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNoticeTimeout } from './useNoticeTimeout';

/** Six characters: the 6000 ms floor. */
const SHORT = 'Saved.';
/** Fourteen characters: also the 6000 ms floor. */
const ANOTHER_SHORT = 'Another saved.';
/** 150 characters: 60 ms x 150 = 9000 ms. */
const MEDIUM = 'x'.repeat(150);
/** 400 characters: 24000 ms uncapped, so the 15000 ms cap applies. */
const LONG = 'x'.repeat(400);
/** The three error classifications in App.tsx: 'could not', 'before' and 'not available'. */
const ERROR_NOTICES = [
  'Could not save the workflow.',
  'Start the run before approving.',
  'Remote approval is not available yet.',
];

function Toast({ notice, clear }: { notice: string; clear: () => void }) {
  const handlers = useNoticeTimeout(notice, clear);
  return notice ? (
    <div role="status" {...handlers}>
      {notice}
    </div>
  ) : null;
}

const run = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

describe('useNoticeTimeout (UI5 section 2; matrix M4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('[RED] a short non-error notice clears once, after 6000 ms', () => {
    const clear = vi.fn();
    render(<Toast notice={SHORT} clear={clear} />);

    run(5999);
    expect(clear).not.toHaveBeenCalled();
    run(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['150 characters', MEDIUM, 9000],
    ['400 characters, capped', LONG, 15000],
  ])(
    '[RED] the timeout scales at 60 ms a character from 6000 ms, capped at 15000 ms (%s)',
    (_label, notice, ms) => {
      const clear = vi.fn();
      render(<Toast notice={notice} clear={clear} />);

      run(ms - 1);
      expect(clear).not.toHaveBeenCalled();
      run(1);
      expect(clear).toHaveBeenCalledTimes(1);
    },
  );

  it.each(ERROR_NOTICES)('[RED] an error notice never clears: "%s" is still shown after 120 s', (notice) => {
    const clear = vi.fn();
    render(<Toast notice={notice} clear={clear} />);

    run(120_000);
    expect(clear).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe(notice);
  });

  it('[RED] hover pauses the timer, and leaving restarts it from the full 9000 ms', () => {
    const clear = vi.fn();
    render(<Toast notice={MEDIUM} clear={clear} />);
    const toast = screen.getByRole('status');

    run(5000);
    fireEvent.pointerEnter(toast);
    run(60_000);
    expect(clear).not.toHaveBeenCalled();

    fireEvent.pointerLeave(toast);
    run(8999);
    expect(clear).not.toHaveBeenCalled();
    run(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['focus', (el: HTMLElement) => fireEvent.focus(el), (el: HTMLElement) => fireEvent.blur(el)],
    ['touch', (el: HTMLElement) => fireEvent.touchStart(el), (el: HTMLElement) => fireEvent.touchEnd(el)],
    ['pointer', (el: HTMLElement) => fireEvent.pointerDown(el), (el: HTMLElement) => fireEvent.pointerUp(el)],
  ])('[RED] %s pauses the timer, and release restarts it from the full 6000 ms', (_source, start, end) => {
    const clear = vi.fn();
    render(<Toast notice={SHORT} clear={clear} />);
    const toast = screen.getByRole('status');

    run(3000);
    start(toast);
    run(60_000);
    expect(clear).not.toHaveBeenCalled();

    end(toast);
    run(5999);
    expect(clear).not.toHaveBeenCalled();
    run(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('[RED] two active sources keep the timer paused until both have ended', () => {
    const clear = vi.fn();
    render(<Toast notice={SHORT} clear={clear} />);
    const toast = screen.getByRole('status');

    fireEvent.pointerEnter(toast);
    fireEvent.focus(toast);
    fireEvent.pointerLeave(toast);
    run(60_000);
    expect(clear).not.toHaveBeenCalled();

    fireEvent.blur(toast);
    run(5999);
    expect(clear).not.toHaveBeenCalled();
    run(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('[RED] a new notice text restarts the timer for that text', () => {
    const clear = vi.fn();
    const { rerender } = render(<Toast notice={SHORT} clear={clear} />);

    run(5000);
    rerender(<Toast notice={ANOTHER_SHORT} clear={clear} />);
    run(5000);
    expect(clear).not.toHaveBeenCalled();
    run(1000);
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
