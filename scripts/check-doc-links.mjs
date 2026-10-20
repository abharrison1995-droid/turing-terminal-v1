// Fails when a relative link in a Markdown file points at a path that does not exist.
// docs/history is skipped: it is a frozen record and may cite files that have since been removed.
// External links (any scheme), in-page anchors and anything inside code are not checked.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SKIP = ['docs/history/', 'node_modules/'];

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\n')
  .filter((file) => file && !SKIP.some((prefix) => file.startsWith(prefix)) && existsSync(join(root, file)));

const INLINE = /\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const REFERENCE = /^\s*\[[^\]]+\]:\s*(\S+)/;

function targetsIn(line) {
  const withoutCode = line.replace(/`[^`]*`/g, '');
  const targets = [...withoutCode.matchAll(INLINE)].map((match) => match[1].replace(/^<|>$/g, ''));
  const reference = withoutCode.match(REFERENCE);
  if (reference) targets.push(reference[1]);
  return targets;
}

const broken = [];
for (const file of files) {
  let fenced = false;
  readFileSync(join(root, file), 'utf8')
    .split('\n')
    .forEach((line, index) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return;
      for (const target of targetsIn(line)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
        const path = decodeURIComponent(target.split('#')[0].split('?')[0]);
        if (!path) continue;
        const absolute = path.startsWith('/') ? join(root, path) : join(root, dirname(file), path);
        if (!existsSync(absolute)) broken.push(`${file}:${index + 1}: ${target}`);
      }
    });
}

if (broken.length > 0) {
  console.error(`Broken relative links (${broken.length}):`);
  for (const entry of broken) console.error(`  ${entry}`);
  process.exit(1);
}
console.log(`Checked relative links in ${files.length} Markdown files.`);
