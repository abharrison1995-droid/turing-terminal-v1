import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const linuxService = readFileSync(
  new URL('../../packaging/linux/turing-terminal.service.in', import.meta.url),
  'utf8',
);
const linuxInstaller = readFileSync(
  new URL('../../packaging/linux/install-user-service.sh', import.meta.url),
  'utf8',
);
const windowsInstaller = readFileSync(
  new URL('../../packaging/windows/install-user-startup.ps1', import.meta.url),
  'utf8',
);

describe('desktop startup security', () => {
  it('keeps the Linux master loopback-only and applies restrictive service/data permissions', () => {
    expect(linuxService).toContain('Environment=TT_HOST=127.0.0.1');
    expect(linuxService).toContain('UMask=0077');
    expect(linuxService).toContain('NoNewPrivileges=true');
    expect(linuxService).toContain('PrivateTmp=true');
    expect(linuxInstaller).toContain('chmod 700 "$DATA_DIR"');
    expect(linuxInstaller).toContain('chmod 600 "$UNIT_DIR/turing-terminal.service"');
  });

  it("keeps Windows startup under the current user's limited scheduled-task principal", () => {
    expect(windowsInstaller).toContain('Join-Path $env:LOCALAPPDATA');
    expect(windowsInstaller).toMatch(
      /New-ScheduledTaskPrincipal[^\n]*-LogonType Interactive -RunLevel Limited/,
    );
  });
});
