import type { MachineStatus } from '../shared/types';

export const MACHINE_PROFILES_KEY = 'turing-terminal.machine-profiles.v1';
const MACHINE_PROFILES_PARAM = 'ttMachines';
const MAX_PROFILES = 20;
const MAX_TRANSFER_CHARS = 16_000;

export interface MachineProfile {
  origin: string;
  machineId: string | null;
  name: string;
  hostname: string | null;
  os: string | null;
  lastSeenAt: string | null;
  reachability: 'online' | 'offline' | 'unknown';
}

export function normalizeMachineOrigin(value: string): string | null {
  if (value.trim().length > 512) return null;
  try {
    const url = new URL(value.trim());
    if (
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname)))
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function readMachineProfiles(storage: Pick<Storage, 'getItem'>): MachineProfile[] {
  try {
    const parsed = JSON.parse(storage.getItem(MACHINE_PROFILES_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(parseMachineProfile)
      .filter((profile): profile is MachineProfile => profile !== null)
      .slice(0, MAX_PROFILES);
  } catch {
    return [];
  }
}

export function writeMachineProfiles(storage: Pick<Storage, 'setItem'>, profiles: MachineProfile[]): void {
  try {
    storage.setItem(MACHINE_PROFILES_KEY, JSON.stringify(uniqueProfiles(profiles).slice(0, MAX_PROFILES)));
  } catch {
    // Storage can be disabled or full; machine selection still works for the current session.
  }
}

export function upsertCurrentMachine(
  profiles: MachineProfile[],
  origin: string,
  machine: MachineStatus,
): MachineProfile[] {
  const normalized = normalizeMachineOrigin(origin);
  if (!normalized) return profiles;
  return uniqueProfiles([
    ...profiles.filter((profile) => profile.origin !== normalized),
    {
      origin: normalized,
      machineId: machine.id,
      name: machine.name,
      hostname: machine.hostname,
      os: machine.os,
      lastSeenAt: machine.lastSeenAt,
      reachability: 'online',
    },
  ]).slice(0, MAX_PROFILES);
}

export function addMachineProfile(
  profiles: MachineProfile[],
  input: { origin: string; name: string },
): MachineProfile[] | null {
  const origin = normalizeMachineOrigin(input.origin);
  const name = input.name.trim().slice(0, 80);
  if (!origin || !name) return null;
  const existing = profiles.find((profile) => profile.origin === origin);
  return uniqueProfiles([
    ...profiles.filter((profile) => profile.origin !== origin),
    {
      origin,
      machineId: existing?.machineId ?? null,
      name,
      hostname: existing?.hostname ?? null,
      os: existing?.os ?? null,
      lastSeenAt: existing?.lastSeenAt ?? null,
      reachability: existing?.reachability ?? 'unknown',
    },
  ]).slice(0, MAX_PROFILES);
}

export function removeMachineProfile(profiles: MachineProfile[], origin: string): MachineProfile[] {
  return profiles.filter((profile) => profile.origin !== origin);
}

export function machineSwitchUrl(profile: MachineProfile, profiles: MachineProfile[]): string {
  const url = new URL(profile.origin);
  url.searchParams.set(
    MACHINE_PROFILES_PARAM,
    JSON.stringify(uniqueProfiles(profiles).slice(0, MAX_PROFILES)),
  );
  return url.toString();
}

export function importMachineProfilesFromLocation(
  currentUrl: string,
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  replaceUrl: (url: string) => void,
): MachineProfile[] {
  const url = new URL(currentUrl);
  const transfer = url.searchParams.get(MACHINE_PROFILES_PARAM);
  if (!transfer) return readMachineProfiles(storage);
  url.searchParams.delete(MACHINE_PROFILES_PARAM);
  replaceUrl(`${url.pathname}${url.search}${url.hash}`);
  const current = readMachineProfiles(storage);
  if (transfer.length > MAX_TRANSFER_CHARS) return current;
  try {
    const incoming = JSON.parse(transfer) as unknown;
    if (!Array.isArray(incoming)) return current;
    const imported = incoming
      .map(parseMachineProfile)
      .filter((profile): profile is MachineProfile => profile !== null);
    const merged = uniqueProfiles([...current, ...imported]).slice(0, MAX_PROFILES);
    writeMachineProfiles(storage, merged);
    return merged;
  } catch {
    return current;
  }
}

export async function probeMachine(
  profile: MachineProfile,
  fetcher: typeof fetch = fetch,
): Promise<'online' | 'offline'> {
  try {
    const response = await fetcher(new URL('/api/health', profile.origin), {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
    });
    const health = (await response.json().catch(() => null)) as { ok?: unknown; service?: unknown } | null;
    return response.ok && health?.ok === true && health.service === 'turing-terminal' ? 'online' : 'offline';
  } catch {
    return 'offline';
  }
}

function parseMachineProfile(value: unknown): MachineProfile | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const origin = typeof candidate.origin === 'string' ? normalizeMachineOrigin(candidate.origin) : null;
  const name = typeof candidate.name === 'string' ? candidate.name.trim().slice(0, 80) : '';
  if (!origin || !name) return null;
  const reachability = candidate.reachability;
  return {
    origin,
    machineId: typeof candidate.machineId === 'string' ? candidate.machineId.slice(0, 100) : null,
    name,
    hostname: typeof candidate.hostname === 'string' ? candidate.hostname.slice(0, 120) : null,
    os: typeof candidate.os === 'string' ? candidate.os.slice(0, 40) : null,
    lastSeenAt:
      typeof candidate.lastSeenAt === 'string' && Number.isFinite(Date.parse(candidate.lastSeenAt))
        ? candidate.lastSeenAt.slice(0, 40)
        : null,
    reachability: reachability === 'online' || reachability === 'offline' ? reachability : 'unknown',
  };
}

function uniqueProfiles(profiles: MachineProfile[]): MachineProfile[] {
  const byOrigin = new Map<string, MachineProfile>();
  for (const profile of profiles) {
    const origin = normalizeMachineOrigin(profile.origin);
    if (!origin || !profile.name.trim()) continue;
    byOrigin.set(origin, { ...profile, origin });
  }
  return [...byOrigin.values()];
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}
