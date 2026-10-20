export const quotaProviderOptions = [
  { id: 'anthropic-subscription', name: 'Claude subscription' },
  { id: 'openai-codex', name: 'OpenAI Codex subscription' },
  { id: 'opencode-go', name: 'OpenCode Go' },
  { id: 'cline-pass', name: 'ClinePass' },
];

export function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function formatDuration(start: string | null, end: string | null): string {
  if (!start) return '—';
  const duration = Math.max(0, (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime());
  const seconds = Math.floor(duration / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function formatMilliseconds(durationMs: number): string {
  const seconds = Math.floor(Math.max(0, durationMs) / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function toDateTimeLocal(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function quotaUnitLabel(unit: string): string {
  return (
    {
      input_tokens: 'input tokens',
      output_tokens: 'output tokens',
      total_tokens: 'tokens',
      requests: 'requests',
      minutes: 'minutes',
    }[unit] ?? unit
  );
}

export function commandText(command: string[] | null): string {
  return command?.join(' ') ?? '';
}

export function parseCommand(value: string): string[] | null {
  const parts = value.trim().split(/\s+/);
  return !value.trim() ? null : parts.length === 3 ? parts : null;
}
