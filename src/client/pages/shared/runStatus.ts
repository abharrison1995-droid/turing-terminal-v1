import type { RunSummary } from '../../../shared/types';
import { formatMilliseconds } from './format';

export const activeStatuses = new Set([
  'queued',
  'preparing',
  'running',
  'waiting_for_approval',
  'waiting_for_user',
  'retrying',
  'cancelling',
]);

export const waitingStatuses = new Set(['waiting_for_approval', 'waiting_for_user']);

export function humanStatus(value: string): string {
  const text = value.replaceAll('_', ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function humanize(value: string): string {
  return value
    .replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)
    .replace(/^./, (letter) => letter.toUpperCase());
}

export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function shortTask(value: string): string {
  return value.length > 72 ? `${value.slice(0, 69)}…` : value;
}

export function rowTime(run: RunSummary): string {
  if (activeStatuses.has(run.status)) return formatMilliseconds(run.elapsedMs);
  const then = new Date(run.completedAt ?? run.createdAt).getTime();
  if (Number.isNaN(then)) return '';
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1_440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1_440)}d ago`;
}
