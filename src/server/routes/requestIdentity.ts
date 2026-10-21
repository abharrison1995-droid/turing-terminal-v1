import type { FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';

export function getTailscaleLogin(value: string | string[] | undefined): string | null {
  const login = Array.isArray(value) ? value[0] : value;
  return typeof login === 'string' && login.trim() ? login.trim().toLowerCase() : null;
}

export function isRemoteRequest(headers: FastifyRequest['headers'], tailscaleLogin: string | null): boolean {
  if (tailscaleLogin) return true;
  const candidate = headers.origin ?? headers.referer;
  if (typeof candidate === 'string') {
    try {
      if (!isLoopbackHostname(new URL(candidate).hostname)) return true;
    } catch {
      return true;
    }
  }
  const host = typeof headers.host === 'string' ? headers.host : '';
  if (!host) return true;
  try {
    return !isLoopbackHostname(new URL(`http://${host}`).hostname);
  } catch {
    return true;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return ['localhost', '127.0.0.1', '::1', 'tauri.localhost'].includes(normalized);
}

export function hashPairingSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const entry of cookieHeader.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0 || entry.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(entry.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}
