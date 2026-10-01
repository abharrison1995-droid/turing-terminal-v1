const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const ALLOWED_SCRIPTS = new Set(['build', 'test', 'lint']);

export function isSafeProjectCommand(command: string[]): boolean {
  return (
    command.length === 3 &&
    PACKAGE_MANAGERS.has(command[0] ?? '') &&
    command[1] === 'run' &&
    ALLOWED_SCRIPTS.has(command[2] ?? '')
  );
}
