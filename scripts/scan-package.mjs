import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../src-tauri/resources', import.meta.url)));
const forbiddenName =
  /^(?:\.env(?:\..*)?|.*\.(?:sqlite(?:-.*)?|db(?:-.*)?|pem|key|p12|pfx|p7b|p7c|sqlite3))$/i;
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
];
const violations = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await visit(path);
      continue;
    }
    if (forbiddenName.test(entry.name)) violations.push(`${path}: forbidden file type`);
    if (!metadata.isFile() || metadata.size > 8_000_000) continue;
    const bytes = await readFile(path);
    if (bytes.includes(0)) continue;
    const contents = bytes.toString('utf8');
    if (secretPatterns.some((pattern) => pattern.test(contents)))
      violations.push(`${path}: possible credential material`);
  }
}

await visit(root);
if (violations.length) {
  console.error(`Packaging security scan failed:\n${violations.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('Packaging scan passed: no local state, private key, or recognized credential patterns found.');
}
