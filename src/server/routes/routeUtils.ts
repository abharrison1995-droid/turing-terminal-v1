import type { Db } from '../db.js';
import type { RunEngine } from '../runEngine.js';
import { redactSecrets } from '../security.js';

/** What each route module receives from createApp. */
export interface RouteContext {
  db: Db;
  engine: RunEngine;
}

export function jsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

export function safeJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function hasCredentialMaterial(value: unknown): boolean {
  if (typeof value === 'string') return redactSecrets(value) !== value;
  if (Array.isArray(value)) return value.some(hasCredentialMaterial);
  if (value && typeof value === 'object')
    return Object.entries(value as Record<string, unknown>).some(
      ([key, item]) =>
        /secret|token|api.?key|password|cookie|credential/i.test(key) || hasCredentialMaterial(item),
    );
  return false;
}
export function slug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70);
}
export function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
