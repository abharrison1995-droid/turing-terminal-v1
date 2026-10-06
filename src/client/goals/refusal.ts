import { ApiError } from '../api';
import { humanize } from './presentation';

export interface Refusal {
  message: string;
  code: string | null;
  approvalId: string | null;
}

/** A backend refusal, shown plainly. Never a success: callers must not change local state because of it. */
export function toRefusal(error: unknown): Refusal {
  if (error instanceof ApiError)
    return { message: error.message, code: error.code ?? null, approvalId: error.approvalId ?? null };
  return {
    message: error instanceof Error ? error.message : 'The request failed.',
    code: null,
    approvalId: null,
  };
}

export const refusalText = (refusal: Refusal): string =>
  refusal.code ? `${refusal.message} (${humanize(refusal.code)})` : refusal.message;
