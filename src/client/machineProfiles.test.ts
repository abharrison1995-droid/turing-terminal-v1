import { describe, expect, it, vi } from 'vitest';
import {
  addMachineProfile,
  importMachineProfilesFromLocation,
  machineSwitchUrl,
  normalizeMachineOrigin,
  probeMachine,
  readMachineProfiles,
  removeMachineProfile,
  upsertCurrentMachine,
  writeMachineProfiles,
  type MachineProfile,
} from './machineProfiles';

const machine: MachineProfile = {
  origin: 'https://desktop-a.tailnet.example',
  machineId: 'machine-a',
  name: 'Desktop A',
  hostname: 'desktop-a',
  os: 'linux',
  lastSeenAt: '2026-10-01T12:00:00.000Z',
  reachability: 'online',
};

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe('device-local machine profiles', () => {
  it('accepts HTTPS and local loopback origins only', () => {
    expect(normalizeMachineOrigin('https://desktop-b.tailnet.example/')).toBe(
      'https://desktop-b.tailnet.example',
    );
    expect(normalizeMachineOrigin('http://127.0.0.1:4317')).toBe('http://127.0.0.1:4317');
    expect(normalizeMachineOrigin('http://desktop-b.tailnet.example')).toBeNull();
    expect(normalizeMachineOrigin('https://user:password@desktop-b.tailnet.example')).toBeNull();
    expect(normalizeMachineOrigin('https://desktop-b.tailnet.example/admin')).toBeNull();
  });

  it('stores display metadata without accepting credential fields', () => {
    const storage = memoryStorage();
    writeMachineProfiles(storage, [machine]);
    expect(readMachineProfiles(storage)).toEqual([machine]);
    storage.setItem(
      'turing-terminal.machine-profiles.v1',
      JSON.stringify([{ ...machine, token: 'must-not-be-preserved' }]),
    );
    expect(readMachineProfiles(storage)).toEqual([machine]);
  });

  it('adds and removes explicit machine origins without changing the selected target implicitly', () => {
    const added = addMachineProfile([machine], {
      origin: 'https://desktop-b.tailnet.example',
      name: 'Desktop B',
    });
    expect(added).toHaveLength(2);
    expect(added?.find((item) => item.name === 'Desktop B')?.reachability).toBe('unknown');
    expect(removeMachineProfile(added ?? [], machine.origin)).toEqual([
      expect.objectContaining({ origin: 'https://desktop-b.tailnet.example' }),
    ]);
  });

  it('refreshes the active origin and preserves other separately paired machine profiles', () => {
    expect(
      upsertCurrentMachine([machine], 'https://desktop-b.tailnet.example/', {
        id: 'machine-b',
        name: 'Desktop B',
        hostname: 'desktop-b',
        os: 'windows',
        status: 'online',
        lastSeenAt: '2026-10-01T13:00:00.000Z',
      }),
    ).toEqual([
      machine,
      {
        origin: 'https://desktop-b.tailnet.example',
        machineId: 'machine-b',
        name: 'Desktop B',
        hostname: 'desktop-b',
        os: 'windows',
        lastSeenAt: '2026-10-01T13:00:00.000Z',
        reachability: 'online',
      },
    ]);
  });

  it('transfers only profile metadata when switching and imports it on the target origin', () => {
    const storage = memoryStorage();
    writeMachineProfiles(storage, [machine]);
    const target = addMachineProfile([machine], {
      origin: 'https://desktop-b.tailnet.example',
      name: 'Desktop B',
    })![1]!;
    const destination = machineSwitchUrl(target, [machine, target]);
    expect(destination).toContain('https://desktop-b.tailnet.example/');
    expect(destination).not.toContain('token');

    const replaceUrl = vi.fn();
    const imported = importMachineProfilesFromLocation(destination, storage, replaceUrl);
    expect(imported).toHaveLength(2);
    expect(replaceUrl).toHaveBeenCalledWith('/');
  });

  it('marks a master online only when its no-credential health probe resolves', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, service: 'turing-terminal' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(probeMachine(machine, fetcher)).resolves.toBe('online');
    expect(fetcher).toHaveBeenCalledWith(
      new URL('/api/health', machine.origin),
      expect.objectContaining({ credentials: 'omit', cache: 'no-store' }),
    );
    fetcher.mockRejectedValueOnce(new TypeError('offline'));
    await expect(probeMachine(machine, fetcher)).resolves.toBe('offline');
  });
});
