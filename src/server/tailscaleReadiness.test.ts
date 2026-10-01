import { describe, expect, it } from 'vitest';
import { parseServeConfiguredForMaster, parseTailscaleNodeStatus } from './tailscaleReadiness.js';

describe('Tailscale readiness parsing', () => {
  it('returns only this node identity and connection state', () => {
    const parsed = parseTailscaleNodeStatus(
      JSON.stringify({
        BackendState: 'Running',
        Self: { HostName: 'desktop', TailscaleIPs: ['100.64.1.2', 'fd7a:115c:a1e0::2'] },
        Peer: { secretPeer: { HostName: 'private-laptop' } },
      }),
    );
    expect(parsed).toEqual({
      running: true,
      hostname: 'desktop',
      ips: ['100.64.1.2', 'fd7a:115c:a1e0::2'],
    });
    expect(JSON.stringify(parsed)).not.toContain('private-laptop');
  });

  it('reports Serve target configuration without exposing its status document', () => {
    expect(parseServeConfiguredForMaster('{"Web":{"https://desktop.ts.net:443":"127.0.0.1:4317"}}')).toBe(
      true,
    );
    expect(parseServeConfiguredForMaster('{"Web":{}}')).toBe(false);
    expect(parseServeConfiguredForMaster('not json')).toBeNull();
  });
});
