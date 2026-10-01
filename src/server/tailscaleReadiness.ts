import { execFile as callbackExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(callbackExecFile);

export interface TailscaleNodeStatus {
  running: boolean;
  hostname: string | null;
  ips: string[];
}

export function parseTailscaleNodeStatus(json: string): TailscaleNodeStatus | null {
  try {
    const root = JSON.parse(json) as Record<string, unknown>;
    const self = root.Self;
    if (!self || typeof self !== 'object') return null;
    const node = self as Record<string, unknown>;
    return {
      running: root.BackendState === 'Running',
      hostname: typeof node.HostName === 'string' ? node.HostName.slice(0, 120) : null,
      ips: Array.isArray(node.TailscaleIPs)
        ? node.TailscaleIPs.filter((ip): ip is string => typeof ip === 'string' && ip.length <= 64).slice(
            0,
            4,
          )
        : [],
    };
  } catch {
    return null;
  }
}

export function parseServeConfiguredForMaster(json: string): boolean | null {
  try {
    const value: unknown = JSON.parse(json);
    const serialized = JSON.stringify(value);
    return /(?:127\.0\.0\.1|localhost|\[::1\]):4317\b/i.test(serialized);
  } catch {
    return json.trim() ? null : false;
  }
}

export interface TailscaleProbeResult {
  installed: boolean;
  running: boolean;
  hostname: string | null;
  ips: string[];
  serveConfigured: boolean | null;
  detail: 'ready' | 'stopped' | 'missing' | 'unavailable';
}

export async function probeTailscale(): Promise<TailscaleProbeResult> {
  let output: string;
  try {
    const result = await execFile('tailscale', ['status', '--json'], {
      windowsHide: true,
      timeout: 2_000,
      maxBuffer: 256_000,
    });
    output = result.stdout;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT')
      return {
        installed: false,
        running: false,
        hostname: null,
        ips: [],
        serveConfigured: null,
        detail: 'missing',
      };
    return {
      installed: true,
      running: false,
      hostname: null,
      ips: [],
      serveConfigured: null,
      detail: 'unavailable',
    };
  }
  const node = parseTailscaleNodeStatus(output);
  if (!node)
    return {
      installed: true,
      running: false,
      hostname: null,
      ips: [],
      serveConfigured: null,
      detail: 'unavailable',
    };
  if (!node.running)
    return {
      installed: true,
      running: false,
      hostname: node.hostname,
      ips: node.ips,
      serveConfigured: null,
      detail: 'stopped',
    };
  let serveConfigured: boolean | null = null;
  try {
    const serve = await execFile('tailscale', ['serve', 'status', '--json'], {
      windowsHide: true,
      timeout: 2_000,
      maxBuffer: 256_000,
    });
    serveConfigured = parseServeConfiguredForMaster(serve.stdout);
  } catch {
    serveConfigured = null;
  }
  return {
    installed: true,
    running: true,
    hostname: node.hostname,
    ips: node.ips,
    serveConfigured,
    detail: 'ready',
  };
}
