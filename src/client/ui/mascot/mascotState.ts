import type { RunStatus } from '../../../shared/types';

/*
 * Pure selectors from signals the app already has. Completed, failed and cancelled runs produce no art (UI0 D-4): the
 * mascot never signals success or failure, and the text beside it carries the real status.
 */

/** Shown only while the first load is pending, so it never replaces a loaded snapshot. */
export function mascotForLoading(loading: boolean, hasSnapshot: boolean): 'loading' | null {
  return loading && !hasSnapshot ? 'loading' : null;
}

/** Shown only while the preview request is in flight, and gone once it settles or fails. */
export function mascotForPreview(pending: boolean): 'thinking' | null {
  return pending ? 'thinking' : null;
}

/** Only an actively running run shows thinking. Every other status, terminal ones included, gives no mascot. */
export function mascotForRunStatus(status: RunStatus): 'thinking' | null {
  return status === 'running' ? 'thinking' : null;
}
