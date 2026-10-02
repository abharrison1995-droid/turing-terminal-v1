import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { releaseArtifactNames } from './release-artifact-names.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

describe('desktop release metadata', () => {
  it('keeps application, Tauri, and Cargo versions aligned', () => {
    const packageJson = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
    const tauri = JSON.parse(readFileSync(`${root}/src-tauri/tauri.conf.json`, 'utf8'));
    const cargo = readFileSync(`${root}/src-tauri/Cargo.toml`, 'utf8').match(
      /^version\s*=\s*"([^"]+)"/m,
    )?.[1];
    expect([packageJson.version, tauri.version, cargo]).toEqual(['1.0.0-rc2', '1.0.0-rc2', '1.0.0-rc2']);
  });

  it('uses the required installer names and includes native icon assets', () => {
    expect(releaseArtifactNames('1.0.0-rc2')).toEqual({
      windows: 'Turing-Terminal-Setup-x64-1.0.0-rc2.exe',
      deb: 'turing-terminal_1.0.0-rc2_amd64.deb',
      appimage: 'Turing-Terminal-x86_64-1.0.0-rc2.AppImage',
    });
    for (const icon of ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.ico']) {
      expect(existsSync(`${root}/src-tauri/icons/${icon}`)).toBe(true);
    }
  });
});
