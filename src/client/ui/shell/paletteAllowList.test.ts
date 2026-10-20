// @vitest-environment node

// UI.1c RED tests for the palette allow-list (scope section 3, matrix S8). PALETTE_COMMAND_IDS must be exactly the static
// command ids, and the palette source may not reach the API, Goal, approval or master-control surfaces, nor send any
// non-GET request. Open-run entries are generated from railTasks at runtime, so they are not in the static list.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

/** Loaded per test, so a missing commands.ts fails each case on its own instead of the whole file. */
const loadPaletteIds = async () => (await import('./commands')).PALETTE_COMMAND_IDS;

const EXPECTED_IDS = [
  'nav-workflows',
  'nav-projects',
  'nav-goals',
  'nav-runs',
  'nav-usage',
  'nav-machines',
  'nav-settings',
  'new-task',
  'refresh-data',
];

/** Source with comments removed, so explanatory prose cannot trip the scan. */
const code = (file: string) =>
  readFileSync(join(here, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

const SOURCES = ['commands.ts', 'CommandPalette.tsx'] as const;

/** Anything that reaches the API client, a Goal or approval mutation, the master controls, or the network. */
const FORBIDDEN: Array<{ name: string; pattern: RegExp }> = [
  {
    name: 'imports the api, goalApi or goals api module',
    pattern: /from\s+['"][^'"]*\/(?:api|goals\/api)['"]/,
  },
  { name: 'calls a named api member', pattern: /\bapi\s*\./ },
  {
    name: 'names a Goal, approval, pairing, rename or master-control call',
    pattern:
      /\b(?:goalsApi|goalApi|decideApproval|restartMaster|cancelRun|resumeRun|intervene|claimPairing\w*|completePairing|renameMachine|approvePairingRequest|denyPairingRequest|revokePairedDevice)\b/,
  },
  { name: 'uses the network directly', pattern: /\b(?:fetch|XMLHttpRequest|sendBeacon|WebSocket)\b/ },
  { name: 'sets a request method', pattern: /\b(?:method|POST|PUT|PATCH|DELETE)\b/ },
  {
    name: 'calls a save, delete, patch, create or decide function',
    pattern: /\b(?:save|delete|patch|create|decide)\w*\s*\(/i,
  },
];

describe('PALETTE_COMMAND_IDS (matrix S8)', () => {
  it('is exactly the nine static command ids, with no duplicates', async () => {
    const ids = await loadPaletteIds();
    expect([...ids].sort()).toEqual([...EXPECTED_IDS].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('holds no id that names a mutation, a restricted action or a Goal write', async () => {
    const ids = await loadPaletteIds();
    const restricted =
      /restart|cancel|resume|approv|decid|intervene|save|delete|create|pair|rename|export|patch|stop/i;
    expect(ids.filter((id) => restricted.test(id))).toEqual([]);
  });
});

describe('the palette source is confined to navigation and GET-only refresh (matrix S8)', () => {
  for (const file of SOURCES) {
    it.each(FORBIDDEN.map((rule) => [rule.name, rule.pattern] as const))(`${file} %s`, (_name, pattern) => {
      expect(pattern.exec(code(file))?.[0] ?? null).toBeNull();
    });
  }
});
