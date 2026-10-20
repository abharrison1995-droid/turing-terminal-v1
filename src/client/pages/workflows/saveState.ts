import { ApiError } from '../../api';

export type SaveState =
  | { phase: 'idle' }
  | { phase: 'saving' }
  | { phase: 'saved'; version: number }
  | { phase: 'error'; message: string; reconnect: boolean };

/**
 * Turns a failed save into text a person can act on. The Desktop Master answering with an error is a problem with the
 * workflow; the request never arriving is a connection problem, and the draft is untouched either way.
 */
export function describeSaveFailure(error: unknown): { message: string; reconnect: boolean } {
  if (error instanceof ApiError)
    return {
      message: error.message || 'The Desktop Master rejected this workflow.',
      reconnect: false,
    };
  return {
    message:
      'Could not reach the Desktop Master, so nothing was saved. Your draft is still here. Check that the Desktop Master is running and this device is connected, then press Save again.',
    reconnect: true,
  };
}
