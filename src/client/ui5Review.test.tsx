// @vitest-environment jsdom

// UI.5 review fixes 1 to 3: the notice classifier and the timer's release sources. This is a new file. The committed
// useNoticeTimeout.test.tsx is unchanged, and its existing error classifications must keep passing.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isErrorNotice, useNoticeTimeout } from './useNoticeTimeout';

/** Six characters: the 6000 ms floor. */
const SHORT = 'Saved.';

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

describe('isErrorNotice: failure words keep a notice on screen (review finding 2)', () => {
  it.each([
    'Workflow import failed.',
    'The desktop master did not accept this run.',
    'Voice transcription stopped. Your task has not been submitted.',
    'Failed to fetch',
    'Request error: the desktop master returned 500.',
    'Access denied for this provider.',
    'Connection refused by the desktop master.',
    'Unable to reach the desktop master.',
    "Can't open the workspace right now.",
    'Cannot read properties of undefined.',
    'Run rejected by the approval policy.',
  ])('"%s" is an error', (notice) => {
    expect(isErrorNotice(notice)).toBe(true);
  });

  it.each([
    'Could not save the workflow.',
    'Start the run before approving.',
    'Remote approval is not available yet.',
    'Preview loaded. Setup is needed before this can start.',
  ])('the original classification still holds: "%s" is an error', (notice) => {
    expect(isErrorNotice(notice)).toBe(true);
  });

  it.each([
    'Stop requested. The provider process is being terminated.',
    'Run accepted by the desktop master.',
    'Machine profile saved on this device. Pair with that master separately.',
    'Saved.',
  ])('a success notice is not an error: "%s"', (notice) => {
    expect(isErrorNotice(notice)).toBe(false);
  });

  it('a word boundary keeps "stopped" from matching "Stop requested"', () => {
    expect(isErrorNotice('Stop requested.')).toBe(false);
  });
});

describe('isErrorNotice: the preview-ready success rule (review finding 3)', () => {
  it('"Run preview is ready... before starting" is not an error, though it contains "before"', () => {
    expect(
      isErrorNotice('Run preview is ready. Check its project, stages, and Git strategy before starting.'),
    ).toBe(false);
  });

  it('the preview-ready success rule is case-insensitive', () => {
    expect(isErrorNotice('RUN PREVIEW IS READY. Review it before starting.')).toBe(false);
  });

  it('a preview-ready notice that also reports a failure word stays an error', () => {
    expect(isErrorNotice('Run preview is ready, but Git failed to report the branch.')).toBe(true);
  });

  it('a preview-ready notice that reports "could not" stays an error', () => {
    expect(isErrorNotice('Run preview is ready. The stages could not be loaded.')).toBe(true);
  });

  it('a notice that merely mentions a preview is still classified by the keyword rules', () => {
    expect(isErrorNotice('Preview loaded. Setup is needed before this can start.')).toBe(true);
  });
});

describe('useNoticeTimeout: cancelled and left pointers and touches release the timer (review finding 1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('pointercancel releases a held pointer, and the timer restarts from its full 6000 ms', () => {
    const clear = vi.fn();
    render(<Toast notice={SHORT} clear={clear} />);
    const toast = screen.getByRole('status');

    run(3000);
    fireEvent.pointerDown(toast);
    run(60_000);
    expect(clear).not.toHaveBeenCalled();

    fireEvent.pointerCancel(toast);
    run(5999);
    expect(clear).not.toHaveBeenCalled();
    run(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('touchcancel releases a held touch, and the timer restarts from its full 6000 ms', () => {
    const clear = vi.fn();
    render(<Toast notice={SHORT} clear={clear} />);
    const toast = screen.getByRole('status');

    run(3000);
    fireEvent.touchStart(toast);
    run(60_000);
    expect(clear).not.toHaveBeenCalled();

    fireEvent.touchCancel(toast);
    run(5999);
    expect(clear).not.toHaveBeenCalled();
    run(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('pointerleave releases a held pointer press, for a drag that leaves the toast', () => {
    const clear = vi.fn();
    render(<Toast notice={SHORT} clear={clear} />);
    const toast = screen.getByRole('status');

    fireEvent.pointerDown(toast);
    run(60_000);
    expect(clear).not.toHaveBeenCalled();

    fireEvent.pointerLeave(toast);
    run(5999);
    expect(clear).not.toHaveBeenCalled();
    run(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('pointerleave releases hover and a held pointer together, so one leave ends both', () => {
    const clear = vi.fn();
    render(<Toast notice={SHORT} clear={clear} />);
    const toast = screen.getByRole('status');

    fireEvent.pointerEnter(toast);
    fireEvent.pointerDown(toast);
    run(60_000);
    expect(clear).not.toHaveBeenCalled();

    fireEvent.pointerLeave(toast);
    run(6000);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('touchcancel leaves a focus hold in place, so the timer stays paused', () => {
    const clear = vi.fn();
    render(<Toast notice={SHORT} clear={clear} />);
    const toast = screen.getByRole('status');

    fireEvent.focus(toast);
    fireEvent.touchStart(toast);
    fireEvent.touchCancel(toast);
    run(60_000);
    expect(clear).not.toHaveBeenCalled();

    fireEvent.blur(toast);
    run(6000);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('a pointerup after pointercancel is harmless and does not restart the timer early', () => {
    const clear = vi.fn();
    render(<Toast notice={SHORT} clear={clear} />);
    const toast = screen.getByRole('status');

    fireEvent.pointerDown(toast);
    fireEvent.pointerCancel(toast);
    fireEvent.pointerUp(toast);
    run(5999);
    expect(clear).not.toHaveBeenCalled();
    run(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
