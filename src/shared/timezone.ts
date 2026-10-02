/**
 * Timezone helpers for analytics. Events are stored in UTC; days and hours are bucketed in the
 * selected display timezone so local usage never lands on the wrong day around UTC midnight.
 */

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, value);
  }
  return value;
}

export function zonedParts(epochMs: number, timeZone: string) {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(epochMs))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
  return parts;
}

/** Offset (local − UTC) in milliseconds at an instant. */
export function timeZoneOffsetMs(epochMs: number, timeZone: string): number {
  const p = zonedParts(epochMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

const pad = (value: number) => String(value).padStart(2, '0');

export function localDayKey(at: string | number | Date, timeZone: string): string {
  const p = zonedParts(new Date(at).getTime(), timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function localHourKey(at: string | number | Date, timeZone: string): string {
  const p = zonedParts(new Date(at).getTime(), timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}`;
}

/** UTC instant of local midnight for a YYYY-MM-DD day key in a timezone (DST-safe). */
export function zonedMidnightUtc(dayKey: string, timeZone: string): Date {
  const [year, month, day] = dayKey.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(year, month - 1, day);
  let result = guess - timeZoneOffsetMs(guess, timeZone);
  // Re-evaluate the offset at the candidate in case a DST transition sits between guess and result.
  result = guess - timeZoneOffsetMs(result, timeZone);
  return new Date(result);
}

export function addDays(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function dayKeysBetween(fromKey: string, toKeyInclusive: string): string[] {
  const keys: string[] = [];
  for (let key = fromKey; key <= toKeyInclusive && keys.length < 1_000; key = addDays(key, 1)) keys.push(key);
  return keys;
}

export type RangePreset = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'custom';

/**
 * Resolve a preset into a [from, to) UTC interval aligned to local days in `timeZone`.
 * '7d' and '30d' include today and the preceding 6 / 29 local days.
 */
export function resolveRange(args: {
  preset: RangePreset;
  timeZone: string;
  now?: number;
  fromDay?: string;
  toDay?: string;
}): { from: string; to: string; fromDay: string; toDay: string } {
  const now = args.now ?? Date.now();
  const today = localDayKey(now, args.timeZone);
  let fromDay = today;
  let toDay = today;
  if (args.preset === 'yesterday') fromDay = toDay = addDays(today, -1);
  else if (args.preset === '7d') fromDay = addDays(today, -6);
  else if (args.preset === '30d') fromDay = addDays(today, -29);
  else if (args.preset === 'month') fromDay = `${today.slice(0, 8)}01`;
  else if (args.preset === 'custom') {
    fromDay = args.fromDay && /^\d{4}-\d{2}-\d{2}$/.test(args.fromDay) ? args.fromDay : today;
    toDay = args.toDay && /^\d{4}-\d{2}-\d{2}$/.test(args.toDay) ? args.toDay : today;
    if (toDay < fromDay) [fromDay, toDay] = [toDay, fromDay];
  }
  return {
    from: zonedMidnightUtc(fromDay, args.timeZone).toISOString(),
    to: zonedMidnightUtc(addDays(toDay, 1), args.timeZone).toISOString(),
    fromDay,
    toDay,
  };
}
