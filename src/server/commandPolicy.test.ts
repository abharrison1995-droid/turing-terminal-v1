import { describe, expect, it } from 'vitest';
import { isSafeProjectCommand } from './commandPolicy.js';

describe('project command policy', () => {
  it('accepts only explicit package-manager build, test, and lint scripts', () => {
    expect(isSafeProjectCommand(['npm', 'run', 'build'])).toBe(true);
    expect(isSafeProjectCommand(['pnpm', 'run', 'test'])).toBe(true);
    expect(isSafeProjectCommand(['bun', 'run', 'lint'])).toBe(true);
    expect(isSafeProjectCommand(['sh', '-c', 'npm test'])).toBe(false);
    expect(isSafeProjectCommand(['npm', 'run', 'test; rm -rf /'])).toBe(false);
    expect(isSafeProjectCommand(['npm', 'run', 'test', '--', '--watch'])).toBe(false);
    expect(isSafeProjectCommand(['npm', 'run', '../outside'])).toBe(false);
  });
});
