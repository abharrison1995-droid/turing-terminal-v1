// @vitest-environment node

// UI.2 tests for the Home and run-workspace stylesheets (UI2_SCOPE sections 1 and 2, matrix A1 and C1). They read the CSS
// as text, the same way shellCss.test.ts does. The guards that already hold are marked GREEN; the rest are RED until
// workspace.css exists and the Home rules are reworked. Each workspace check asserts the file exists first, so a missing
// file fails with a clear message rather than a read error.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const indexPath = join(here, 'index.css');
const homePath = join(here, 'home.css');
const mobilePath = join(here, 'mobile.css');
const threadPath = join(here, 'thread.css');
const workspacePath = join(here, 'workspace.css');

const read = (path: string) => readFileSync(path, 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule {
  selectors: string[];
  body: string;
}

/** Flat rules, including ones nested in a media block. Selectors are split on commas and trimmed. */
function rulesIn(css: string): Rule[] {
  return [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1]!
      .split(',')
      .map((selector) => selector.trim())
      .filter(Boolean),
    body: match[2]!,
  }));
}

/** Each @media block with its query and body. Braces are counted, so nested rules stay inside their block. */
function mediaBlocks(css: string): Array<{ query: string; body: string }> {
  const source = stripComments(css);
  const blocks: Array<{ query: string; body: string }> = [];
  const opener = /@media\s*([^{]+)\{/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source))) {
    let depth = 1;
    let index = opener.lastIndex;
    while (index < source.length && depth > 0) {
      if (source[index] === '{') depth += 1;
      else if (source[index] === '}') depth -= 1;
      index += 1;
    }
    blocks.push({ query: match[1]!.trim(), body: source.slice(opener.lastIndex, index - 1) });
  }
  return blocks;
}

/** The stylesheet with every @media block whose query matches removed, so what is left is unguarded. */
function withoutMediaBlocks(css: string, query: RegExp): string {
  const source = stripComments(css);
  let result = source;
  for (const match of source.matchAll(/@media\s*([^{]+)\{/g)) {
    if (!query.test(match[1]!)) continue;
    let depth = 1;
    let index = match.index! + match[0].length;
    while (index < source.length && depth > 0) {
      if (source[index] === '{') depth += 1;
      else if (source[index] === '}') depth -= 1;
      index += 1;
    }
    result = result.replace(source.slice(match.index!, index), '');
  }
  return result;
}

const workspaceCss = () => {
  expect(existsSync(workspacePath), 'workspace.css exists').toBe(true);
  return read(workspacePath);
};

describe('workspace.css is wired into the cascade (matrix C1)', () => {
  it('[RED] index.css imports ./workspace.css after the Home and thread rules', () => {
    expect(existsSync(workspacePath), 'workspace.css exists').toBe(true);
    const imports = [...read(indexPath).matchAll(/@import\s+['"]\.\/([^'"]+)['"]/g)].map((match) => match[1]);
    expect(imports).toContain('workspace.css');
    expect(imports.indexOf('workspace.css')).toBeGreaterThan(imports.indexOf('thread.css'));
  });
});

describe('Home heading order keeps the intro in the DOM on compact widths (matrix A1)', () => {
  it('[RED] no rule hides .home-intro with display:none; compact uses an sr-only pattern instead', () => {
    const hidden = [homePath, mobilePath, threadPath, workspacePath]
      .filter((path) => existsSync(path))
      .flatMap((path) => rulesIn(read(path)))
      .filter(
        (rule) =>
          rule.selectors.some((selector) => selector.includes('.home-intro')) &&
          /display\s*:\s*none/.test(rule.body),
      )
      .flatMap((rule) => rule.selectors);

    expect(hidden).toEqual([]);
  });
});

describe('compact touch targets (matrix C1)', () => {
  it('[RED] on a narrow viewport the launch-blocker action and the run-workspace tabs are at least 44px', () => {
    const compact = [mobilePath, workspacePath]
      .filter((path) => existsSync(path))
      .flatMap((path) => mediaBlocks(read(path)))
      .filter((block) => /max-width/.test(block.query))
      .flatMap((block) => rulesIn(block.body));
    const minHeightOn = (selector: string) =>
      compact.some(
        (rule) =>
          rule.selectors.some((item) => item.replace(/"/g, "'") === selector) &&
          /min-height\s*:\s*44px\b/.test(rule.body),
      );

    expect(minHeightOn('.launch-blockers .text-button')).toBe(true);
    expect(minHeightOn("[role='tab']")).toBe(true);
  });
});

describe('the run diff pane (matrix R2, C1)', () => {
  it('[RED] the diff pane in workspace.css scrolls with overflow:auto', () => {
    const rules = rulesIn(workspaceCss());

    const scrolls = rules.some(
      (rule) =>
        rule.selectors.some((selector) => /diff/i.test(selector)) &&
        /overflow(?:-y)?\s*:\s*auto\b/.test(rule.body),
    );
    expect(scrolls).toBe(true);
  });

  it('[RED] workspace.css uses no display face and no colour literal', () => {
    const source = workspaceCss();

    expect(source).not.toMatch(/--font-display|UnifrakturCook/);
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\b(?:rgba?|hsla?|hwb|oklch|oklab|color)\(/i);
  });

  it('[RED] any animation or transition in workspace.css sits inside a prefers-reduced-motion: no-preference guard', () => {
    const unguarded = withoutMediaBlocks(workspaceCss(), /prefers-reduced-motion:\s*no-preference/);

    expect(unguarded).not.toMatch(/\b(?:animation|transition)(?:-[a-z-]+)?\s*:/);
  });
});
