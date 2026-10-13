import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginInflight,
  clearInflightWritesForTests,
  type InflightHandle,
  type InflightWrite,
  isInflight,
  isInflightAt,
  MAX_INFLIGHT_WRITES,
  settleInflight,
  subscribeInflight,
} from './inflightWrites';

const digest = (character: string) => character.repeat(64);

const recordWrite = (over: Partial<InflightWrite> = {}): InflightWrite => ({
  goalId: 'goal-1',
  handoffId: null,
  attestationId: 'attestation-a',
  kind: 'record',
  identity: digest('7'),
  detail: null,
  ...over,
});

/** A handle for a write that must be accepted. A busy answer fails the test here, with a readable message. */
function acceptedHandle(write: InflightWrite, owner = 'owner-1'): InflightHandle {
  const handle = beginInflight(write, owner);
  if (handle === 'busy') throw new Error(`expected ${write.kind} to begin, got busy`);
  return handle;
}

afterEach(() => {
  clearInflightWritesForTests();
});

describe('the in-flight key', () => {
  it('binds the Goal, the handoff, the attestation, the kind, the identity and the detail', () => {
    acceptedHandle(recordWrite());
    const variants: InflightWrite[] = [
      recordWrite({ goalId: 'goal-2' }),
      recordWrite({ handoffId: 'handoff-v2' }),
      recordWrite({ attestationId: 'attestation-b' }),
      recordWrite({ kind: 'complete' }),
      recordWrite({ identity: digest('3') }),
      recordWrite({ detail: '{"explanation":null}' }),
    ];
    for (const variant of variants) {
      expect(isInflight(variant)).toBe(false);
      expect(beginInflight(variant, 'owner-1')).not.toBe('busy');
    }
    expect(isInflight(recordWrite())).toBe(true);
  });

  it('answers busy for the same key while it is in flight, for any owner', () => {
    acceptedHandle(recordWrite());
    expect(beginInflight(recordWrite(), 'owner-1')).toBe('busy');
    expect(beginInflight(recordWrite(), 'owner-2')).toBe('busy');
    expect(isInflight(recordWrite())).toBe(true);
  });

  it('keeps a different Goal, attestation, kind or identity independent of an entry in flight', () => {
    acceptedHandle(recordWrite());
    for (const other of [
      recordWrite({ goalId: 'goal-2' }),
      recordWrite({ attestationId: 'attestation-b' }),
      recordWrite({ kind: 'complete', identity: digest('6') }),
      recordWrite({ identity: digest('3') }),
    ]) {
      expect(beginInflight(other, 'owner-1')).not.toBe('busy');
    }
  });

  it('matches the identity with any detail through isInflightAt, and ignores the write the asking owner began', () => {
    const handle = acceptedHandle(
      recordWrite({
        kind: 'correction-request',
        identity: digest('a'),
        detail: '{"reasonCode":"observation_error"}',
      }),
      'owner-1',
    );
    const probe = {
      goalId: 'goal-1',
      handoffId: null,
      attestationId: 'attestation-a',
      kind: 'correction-request' as const,
      identity: digest('a'),
    };
    expect(isInflightAt(probe, 'owner-2')).toBe(true);
    // The owner that began the write does not count it against its own later read.
    expect(isInflightAt(probe, 'owner-1')).toBe(false);
    expect(isInflightAt({ ...probe, identity: digest('b') }, 'owner-2')).toBe(false);
    settleInflight(handle);
    expect(isInflightAt(probe, 'owner-2')).toBe(false);
  });
});

describe('settling an entry', () => {
  it('removes the entry, so the same key can begin again', () => {
    const handle = acceptedHandle(recordWrite());
    settleInflight(handle);
    expect(isInflight(recordWrite())).toBe(false);
    expect(beginInflight(recordWrite(), 'owner-1')).not.toBe('busy');
  });

  it('lets a stale handle settle only its own entry, never a newer entry with the same key', () => {
    const first = acceptedHandle(recordWrite());
    settleInflight(first);
    const second = acceptedHandle(recordWrite());
    settleInflight(first);
    expect(isInflight(recordWrite())).toBe(true);
    settleInflight(second);
    expect(isInflight(recordWrite())).toBe(false);
  });

  it('carries no state from one key to another', () => {
    const settled = acceptedHandle(recordWrite({ identity: digest('1') }));
    settleInflight(settled);
    const other = acceptedHandle(recordWrite({ identity: digest('2') }));
    expect(isInflight(recordWrite({ identity: digest('1') }))).toBe(false);
    expect(isInflight(recordWrite({ identity: digest('2') }))).toBe(true);
    settleInflight(other);
    expect(isInflight(recordWrite({ identity: digest('2') }))).toBe(false);
  });
});

describe('the bound', () => {
  const distinct = (index: number) => recordWrite({ identity: index.toString(16).padStart(64, '0') });

  it('holds at most sixteen entries and answers busy for a seventeenth without evicting any', () => {
    expect(MAX_INFLIGHT_WRITES).toBe(16);
    const handles = Array.from({ length: MAX_INFLIGHT_WRITES }, (_, index) =>
      acceptedHandle(distinct(index)),
    );
    expect(beginInflight(distinct(MAX_INFLIGHT_WRITES), 'owner-1')).toBe('busy');
    for (let index = 0; index < MAX_INFLIGHT_WRITES; index += 1)
      expect(isInflight(distinct(index))).toBe(true);
    expect(handles).toHaveLength(MAX_INFLIGHT_WRITES);
  });

  it('frees a slot only when an entry settles', () => {
    const handles = Array.from({ length: MAX_INFLIGHT_WRITES }, (_, index) =>
      acceptedHandle(distinct(index)),
    );
    expect(beginInflight(distinct(MAX_INFLIGHT_WRITES), 'owner-1')).toBe('busy');
    settleInflight(handles[5]!);
    expect(isInflight(distinct(5))).toBe(false);
    expect(beginInflight(distinct(MAX_INFLIGHT_WRITES), 'owner-1')).not.toBe('busy');
    expect(isInflight(distinct(0))).toBe(true);
  });
});

describe('subscriptions', () => {
  it('notifies another owner of the same Goal and attestation when a write settles, and no one else', () => {
    const notified: string[] = [];
    subscribeInflight('goal-1', 'attestation-a', 'panel-new', () => notified.push('panel-new'));
    subscribeInflight('goal-1', 'attestation-b', 'other-attestation', () =>
      notified.push('other-attestation'),
    );
    subscribeInflight('goal-2', 'attestation-a', 'other-goal', () => notified.push('other-goal'));
    const handle = acceptedHandle(recordWrite(), 'panel-old');
    settleInflight(handle);
    expect(notified).toEqual(['panel-new']);
  });

  it('does not notify the owner that began the write, or a listener that has unsubscribed', () => {
    const notified: string[] = [];
    const unsubscribeOld = subscribeInflight('goal-1', 'attestation-a', 'panel-old', () =>
      notified.push('panel-old'),
    );
    const unsubscribeNew = subscribeInflight('goal-1', 'attestation-a', 'panel-new', () =>
      notified.push('panel-new'),
    );
    unsubscribeNew();
    const handle = acceptedHandle(recordWrite(), 'panel-old');
    settleInflight(handle);
    expect(notified).toEqual([]);
    unsubscribeOld();
  });
});

describe('the test-only reset is guarded', () => {
  it('C1 clearInflightWritesForTests throws outside Vitest test mode and keeps the entries', () => {
    acceptedHandle(recordWrite());
    vi.stubEnv('MODE', 'production');
    try {
      expect(() => clearInflightWritesForTests()).toThrow();
      expect(isInflight(recordWrite())).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
    clearInflightWritesForTests();
    expect(isInflight(recordWrite())).toBe(false);
  });
});

/*
 * Static guard for the test-only reset. Every non-test .ts and .tsx file under src is scanned with the same recursive
 * walk as goalAuthorityStaticGuard.test.ts. Only inflightWrites.ts may name the reset.
 */
const SRC_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RESET_NAME = 'clearInflightWritesForTests';
const OWNER_PATH = 'client/goals/inflightWrites.ts';

function productionSources(dir = SRC_ROOT): { path: string; source: string }[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return productionSources(full);
    const isProduction = (name.endsWith('.ts') || name.endsWith('.tsx')) && !/\.test\.tsx?$/.test(name);
    return isProduction ? [{ path: relative(SRC_ROOT, full), source: readFileSync(full, 'utf8') }] : [];
  });
}

const referencing = (sources: { path: string; source: string }[], name: string) =>
  sources.filter((file) => file.source.includes(name)).map((file) => file.path);

describe('the test-only reset is referenced only by its owner', () => {
  it('C2 no production .ts or .tsx file other than inflightWrites.ts names the reset', () => {
    const sources = productionSources();
    expect(sources.length).toBeGreaterThan(100);
    expect(referencing(sources, RESET_NAME)).toEqual([OWNER_PATH]);
  });

  it('C3 the scanner flags a seeded production import of the reset and passes a clean file', () => {
    const seeded = [
      {
        path: 'client/goals/Seeded.tsx',
        source: "import { clearInflightWritesForTests } from './inflightWrites';",
      },
      { path: 'client/goals/Clean.ts', source: 'export const clean = 1;' },
    ];
    expect(referencing(seeded, RESET_NAME)).toEqual(['client/goals/Seeded.tsx']);
  });
});
