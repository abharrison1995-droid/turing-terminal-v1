// @vitest-environment jsdom

// UI.6 A5 (UI6_SCOPE sections 2, 4 and 5): where the mascot may appear. The two scans read the client source as text.
// The render check renders Loading from pages/shared/parts.tsx.
//
// Allow-list: only pages/shared/parts.tsx, pages/CommandCenter.tsx and pages/RunsPage.tsx, plus files inside ui/mascot,
// may import the mascot. Nothing under goals/, goals/UnifiedApprovals.tsx, ui/shell/NavGuardDialog.tsx or
// ui/shell/Sidebar.tsx may.
//
// Tests labelled GUARD pass today: no file imports the mascot yet, so they are a fence for the future, not proof that the
// placement exists. The render check (RED) needs Loading to show the mascot beside its connecting text.

import { cleanup, render } from '@testing-library/react';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const mascotDir = here;
const clientRoot = resolve(here, '../..');

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path);
    return [path];
  });

const sourceFiles = walk(clientRoot).filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path));
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

/** True when the file imports the mascot directory, through a relative path or a ui/mascot specifier. */
function importsMascot(file: string): boolean {
  return [...readFileSync(file, 'utf8').matchAll(IMPORT_SPECIFIER)].some(([, specifier]) => {
    if (specifier!.startsWith('.')) {
      const target = resolve(dirname(file), specifier!);
      return target === mascotDir || target.startsWith(mascotDir + sep);
    }
    return /(^|\/)ui\/mascot(\/|$)/.test(specifier!);
  });
}

const insideMascot = (file: string) => file.startsWith(mascotDir + sep);
const rel = (file: string) => relative(clientRoot, file);

describe('mascot placement (UI6 A5)', () => {
  afterEach(() => {
    cleanup();
  });

  // [GUARD] only the three allow-listed pages, and ui/mascot itself, may import the mascot.
  it('lets only the allow-listed pages import the mascot', () => {
    const allowed = new Set(
      ['pages/shared/parts.tsx', 'pages/CommandCenter.tsx', 'pages/RunsPage.tsx'].map((path) =>
        join(clientRoot, path),
      ),
    );
    const importers = sourceFiles.filter((file) => !insideMascot(file) && importsMascot(file));
    expect(importers.filter((file) => !allowed.has(file)).map(rel)).toEqual([]);
  });

  // [GUARD] the forbidden regions exist, so the fence means something, and none of them imports the mascot.
  it('keeps the mascot out of goals/, UnifiedApprovals, NavGuardDialog and shell/Sidebar', () => {
    const forbidden = [
      join(clientRoot, 'goals'),
      join(clientRoot, 'goals', 'UnifiedApprovals.tsx'),
      join(clientRoot, 'ui', 'shell', 'NavGuardDialog.tsx'),
      join(clientRoot, 'ui', 'shell', 'Sidebar.tsx'),
    ];
    for (const path of forbidden) expect(existsSync(path), rel(path)).toBe(true);
    const offenders = sourceFiles.filter(
      (file) => forbidden.some((path) => file === path || file.startsWith(path + sep)) && importsMascot(file),
    );
    expect(offenders.map(rel)).toEqual([]);
  });

  // [RED] Loading (which replaces the spinner) renders the mascot with "Connecting to the local master" beside it.
  it('Loading renders the mascot beside the connecting text and no spinner', async () => {
    const { Loading } = await import('../../pages/shared/parts');
    const { container } = render(createElement(Loading));
    const svg = container.querySelector('svg[data-mascot]');
    expect(svg).not.toBeNull();
    const sibling = svg!.nextElementSibling ?? svg!.previousElementSibling;
    expect(sibling?.textContent).toContain('Connecting to the local master');
    expect(container.querySelector('.spin')).toBeNull();
  });

  // [RED] the mascot never sits inside an alert, alertdialog, dialog or aria-modal region.
  it('Loading keeps the mascot out of alert, dialog and aria-modal regions', async () => {
    const { Loading } = await import('../../pages/shared/parts');
    const { container } = render(createElement(Loading));
    const svg = container.querySelector('svg[data-mascot]');
    expect(svg).not.toBeNull();
    expect(svg!.closest('[role=alert],[role=alertdialog],[role=dialog],[aria-modal]')).toBeNull();
  });
});
