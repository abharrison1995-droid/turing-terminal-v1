// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * UI.1a structural contract: the page components live in `src/client/pages/*` and `App.tsx` is only the shell.
 * The extraction is behaviour-neutral; behaviour is pinned by `appShellCharacterization.test.tsx`.
 */
const pagesDir = __dirname;
const clientDir = join(__dirname, '..');
const read = (path: string) => readFileSync(path, 'utf8');

const pageModules: Record<string, string[]> = {
  'DevicePairingPage.tsx': ['DevicePairingPage'],
  'CommandCenter.tsx': ['CommandCenter'],
  'WorkflowsPage.tsx': ['WorkflowsPage'],
  'ProjectsPage.tsx': ['ProjectsPage'],
  'RunsPage.tsx': ['RunsPage', 'RunDetail'],
  'UsagePage.tsx': ['UsagePage'],
  'MachinesPage.tsx': ['MachinesPage'],
  'SettingsPage.tsx': ['SettingsPage'],
};
const sharedModules = [
  'types.ts',
  'runStatus.ts',
  'format.ts',
  'stageMeta.tsx',
  'parts.tsx',
  'RuleListDetails.tsx',
];

describe('UI.1a page extraction', () => {
  for (const [file, names] of Object.entries(pageModules)) {
    it(`pages/${file} exists and exports ${names.join(', ')}`, () => {
      const path = join(pagesDir, file);
      expect(existsSync(path)).toBe(true);
      const source = read(path);
      for (const name of names) expect(source).toMatch(new RegExp(`export (function|const) ${name}\\b`));
    });
  }

  for (const file of sharedModules) {
    it(`pages/shared/${file} exists`, () => {
      expect(existsSync(join(pagesDir, 'shared', file))).toBe(true);
    });
  }

  it('App.tsx no longer defines the page components or shared page parts', () => {
    const app = read(join(clientDir, 'App.tsx'));
    const moved =
      'DevicePairingPage|CommandCenter|WorkflowsPage|ProjectsPage|RunsPage|RunDetail|UsagePage|MachinesPage|SettingsPage|RulesSettings|PairingSettings|StudioSection|WorkflowStageEditor|PageHeading|EmptyState|Loading';
    expect(app).not.toMatch(new RegExp(`^(export )?function (${moved})\\b`, 'm'));
  });

  it('App.tsx is the shell only', () => {
    expect(read(join(clientDir, 'App.tsx')).split('\n').length).toBeLessThan(900);
  });

  it('App.tsx imports every page from ./pages/', () => {
    const app = read(join(clientDir, 'App.tsx'));
    for (const file of Object.keys(pageModules)) {
      expect(app).toContain(`./pages/${file.replace(/\.tsx$/, '')}`);
    }
  });

  it('keeps the import graph one-directional (no cycles through App or sibling pages)', () => {
    const pageFiles = readdirSync(pagesDir).filter(
      (f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'),
    );
    const siblingNames = Object.keys(pageModules).map((f) => f.replace(/\.tsx$/, ''));
    for (const file of pageFiles) {
      const source = read(join(pagesDir, file));
      expect(source, `${file} must not import App`).not.toMatch(/from '\.\.?\/App'/);
      for (const sibling of siblingNames) {
        expect(source, `${file} must not import sibling page ${sibling}`).not.toMatch(
          new RegExp(`from '\\./${sibling}'`),
        );
      }
    }
    const sharedDir = join(pagesDir, 'shared');
    if (existsSync(sharedDir)) {
      for (const file of readdirSync(sharedDir)) {
        const source = read(join(sharedDir, file));
        expect(source, `shared/${file} must not import App or pages`).not.toMatch(
          /from '(\.\.\/)+App'|from '\.\.\/[A-Z]\w+Page'|from '\.\.\/CommandCenter'/,
        );
      }
    }
  });
});
