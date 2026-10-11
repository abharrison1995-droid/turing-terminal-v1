import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROBE_EDIT_LINE,
  PROBE_EDIT_PATH,
  PROBE_FIXTURE,
  PROBE_READ_PATH,
  PROBE_READ_TOKEN,
} from '../../shared/routeProbe.js';

vi.mock('../providers.js', () => ({
  discoverProviders: vi.fn(async () => []),
  executeProvider: vi.fn(async () => {
    throw new Error('Provider calls are disabled in route probe tests.');
  }),
  invalidateProviderCache: vi.fn(),
}));

import { discoverProviders, executeProvider, type ProviderRunRequest } from '../providers.js';
import { canonicalJson } from './definitionHash.js';
import {
  computeRouteIdentity,
  sha256,
  validationRecordConsistent,
  type RouteSnapshot,
} from './routeIdentity.js';
import {
  createRouteProbe,
  profilesForRoles,
  reconcileRouteProbe,
  routeProbeRequestSchema,
  writeProbeRecord,
} from './routeProbe.js';
import { judgeProfile, PROBE_CHECK_CODES, REQUIRED_CHECKS } from './routeProbeChecks.js';
import {
  buildFixtureRepository,
  FIXTURE_COMMIT_SHA,
  FIXTURE_TREE_SHA,
  fixtureDirectory,
  verifyFixture,
} from './routeProbeFixture.js';
import {
  freshValidationSet,
  latestValidationFor,
  readRouteValidations,
  validationState,
} from './routeValidation.js';
import {
  claude,
  done,
  GOOD_ANSWERS,
  probeBody,
  probeHarness,
  profileOf,
  ROUTE,
  type ProbeHarness,
  type ProbeProfileName,
} from './routeProbeKit.js';
import { REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';

let h: ProbeHarness;
let calls: ProviderRunRequest[];
type Behaviour = (request: ProviderRunRequest, profile: ProbeProfileName) => Promise<ReturnType<typeof done>>;
let overrides: Partial<Record<ProbeProfileName, Behaviour>>;
let gate: Promise<void> | null;

const goodBehaviour: Behaviour = async (request, profile) => {
  if (profile === 'broker-read') {
    await h.broker(request.toolBroker.token, 'read_file', { path: PROBE_READ_PATH });
    return done(JSON.stringify({ profile: 'broker-read', token: PROBE_READ_TOKEN }));
  }
  if (profile === 'broker-edit') {
    await h.broker(request.toolBroker.token, 'write_file', {
      path: PROBE_EDIT_PATH,
      content: `${PROBE_EDIT_LINE}\n`,
    });
    return done('done');
  }
  return done(GOOD_ANSWERS[profile]);
};

beforeEach(() => {
  calls = [];
  overrides = {};
  gate = null;
  vi.mocked(discoverProviders).mockResolvedValue([claude()]);
  vi.mocked(executeProvider).mockImplementation(async (request) => {
    calls.push(request);
    if (gate) await gate;
    const profile = profileOf(request);
    if (!profile) throw new Error('not a probe prompt');
    return (overrides[profile] ?? goodBehaviour)(request, profile);
  });
});

afterEach(async () => {
  await h?.close();
  h = undefined as never;
  vi.mocked(executeProvider).mockReset();
});

const n = (sql: string, ...args: unknown[]) => (h.db.prepare(sql).get(...args) as { n: number }).n;
const records = (runId?: string) =>
  h.db
    .prepare(
      `SELECT * FROM route_validations ${runId ? 'WHERE evidence_run_id = ?' : ''} ORDER BY tested_at, rowid`,
    )
    .all(...(runId ? [runId] : [])) as Array<Record<string, unknown>>;
const probeRow = (probeId: string) =>
  h.db.prepare('SELECT * FROM route_validation_probes WHERE id = ?').get(probeId) as Record<string, unknown>;
const counts = () => ({
  runs: n('SELECT COUNT(*) AS n FROM runs'),
  probes: n('SELECT COUNT(*) AS n FROM route_validation_probes'),
  records: n('SELECT COUNT(*) AS n FROM route_validations'),
});

/** Posts a probe, lets the real engine finish it, and consumes it. */
async function runProbe(roles = ['orchestrator', 'implementer'] as const) {
  const response = await h.post(probeBody([...roles]));
  expect(response.statusCode).toBe(202);
  const { probeId, runId } = response.json as { probeId: string; runId: string };
  await h.waitRun(runId, 'completed');
  const observed = await reconcileRouteProbe(h.db, probeId, h.startRun);
  return { probeId, runId, observed };
}

// --- request, derivation, exact identity -------------------------------------------------------------------------------

describe('POST /api/route-validations: request and exact identity', () => {
  it('accepts only a strict bounded body: member and a non-empty, unique, known role list', async () => {
    h = await probeHarness();
    const before = counts();
    const bad = async (payload: unknown) => (await h.post(payload)).statusCode;
    expect(await bad(probeBody([]))).toBe(400);
    expect(await bad(probeBody(['orchestrator', 'orchestrator']))).toBe(400);
    expect(await bad(probeBody(['judge' as never]))).toBe(400);
    expect(await bad({ roles: ['orchestrator'] })).toBe(400);
    expect(await bad({ ...probeBody(), extra: 1 })).toBe(400);
    expect(await bad({ ...probeBody(), profiles: ['broker-edit'] })).toBe(400);
    // The caller can never state what the server must compute or observe.
    for (const claim of [
      'identityHash',
      'capabilityFingerprint',
      'adapterVersion',
      'modelSnapshot',
      'resolvedModelId',
      'credentialReady',
      'providerReady',
    ])
      expect(await bad({ ...probeBody(), [claim]: 'x' })).toBe(400);
    for (const claim of ['identityHash', 'adapterVersion', 'modelSnapshot', 'credentialReady'])
      expect(await bad(probeBody(['orchestrator'], { ...ROUTE, [claim]: 'x' }))).toBe(400);
    expect(await bad(probeBody(['orchestrator'], { ...ROUTE, billingLane: 'not-a-lane' }))).toBe(400);
    expect(counts()).toEqual(before);
    expect(calls).toHaveLength(0);
  });

  it('derives the profile set from the roles through ROLE_VALIDATION_PROFILES, as a unique union', () => {
    expect(profilesForRoles(['orchestrator'])).toEqual(['orchestrator-json', 'broker-read']);
    expect(profilesForRoles(['implementer'])).toEqual(['broker-read', 'broker-edit']);
    expect(profilesForRoles(['orchestrator', 'implementer'])).toEqual([
      'orchestrator-json',
      'broker-read',
      'broker-edit',
    ]);
    expect(profilesForRoles(['routine_reviewer', 'final_reviewer'])).toEqual(['review-json', 'broker-read']);
    expect(routeProbeRequestSchema.safeParse(probeBody(['implementer'])).success).toBe(true);
  });

  it(
    'answers 202 with bounded ids before the model completes and persists the exact server-captured identity',
    async () => {
      h = await probeHarness();
      let release!: () => void;
      gate = new Promise<void>((resolve) => (release = resolve));
      const response = await h.post(probeBody(['orchestrator', 'implementer']));
      expect(response.statusCode).toBe(202);
      expect(Object.keys(response.json).sort()).toEqual(['identityHash', 'probeId', 'profiles', 'runId']);
      const { probeId, runId, identityHash, profiles } = response.json as {
        probeId: string;
        runId: string;
        identityHash: string;
        profiles: string[];
      };
      expect(profiles).toEqual(['orchestrator-json', 'broker-read', 'broker-edit']);
      expect(h.db.prepare('SELECT status FROM runs WHERE id = ?').get(runId)).not.toEqual({
        status: 'completed',
      });

      // The identity is the one the server computes from its own observation, never one the caller supplied.
      const snapshot: RouteSnapshot = { providers: [claude()], profiles: [] };
      const expected = computeRouteIdentity(
        { configuration: ROUTE, freshnessClass: 'stable-subscription' },
        snapshot,
      );
      if (!expected.ok) throw new Error('fixture');
      expect(identityHash).toBe(expected.value.identityHash);
      const row = probeRow(probeId);
      expect(row).toMatchObject({
        run_id: runId,
        identity_hash: identityHash,
        status: 'pending',
        failure_code: null,
        freshness_class: 'stable-subscription',
        fixture_commit: FIXTURE_COMMIT_SHA,
      });
      expect(row.identity_json).toBe(canonicalJson(expected.value.identity));
      expect(sha256(row.identity_json as string)).toBe(identityHash);
      expect(JSON.parse(row.profiles_json as string)).toEqual(profiles);
      // No credential, provider text or output is stored on the probe.
      expect(JSON.stringify(row)).not.toMatch(/token|secret|credential|password/i);
      release();
      await h.waitRun(runId, 'completed');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it('pins the route exactly on the enabled stages, applies no fallback, and skips profiles that were not requested', async () => {
    h = await probeHarness();
    const { runId } = await runProbe(['orchestrator']);
    const stages = h.db
      .prepare(
        'SELECT stage_key, kind, status, backend_id, provider_id, model_id, billing_lane FROM stages WHERE run_id = ? ORDER BY sequence',
      )
      .all(runId) as Array<Record<string, unknown>>;
    const byKey = new Map(stages.map((stage) => [stage.stage_key, stage]));
    for (const key of ['probe-orchestrator-json', 'probe-broker-read']) {
      expect(byKey.get(key)).toMatchObject({
        status: 'passed',
        backend_id: ROUTE.backendId,
        provider_id: ROUTE.providerId,
        model_id: ROUTE.modelId,
        billing_lane: ROUTE.billingLane,
      });
    }
    for (const key of [
      'probe-structured-readonly',
      'probe-review-json',
      'probe-broker-edit',
      'probe-broker-edit-commit',
    ])
      expect(byKey.get(key)).toMatchObject({ status: 'skipped' });
    // One call per enabled profile stage and every call used exactly the named route.
    expect(calls).toHaveLength(2);
    for (const call of calls)
      expect(call).toMatchObject({
        backendId: ROUTE.backendId,
        providerId: ROUTE.providerId,
        modelId: ROUTE.modelId,
      });
    const snapshot = JSON.parse(
      (
        h.db
          .prepare(
            "SELECT model_snapshot_json AS j FROM stages WHERE run_id = ? AND stage_key = 'probe-broker-read'",
          )
          .get(runId) as { j: string }
      ).j,
    ) as { adapterVersion: string | null };
    // modelSnapshot is observed by the ordinary preview, not supplied.
    expect(snapshot.adapterVersion).toBe('2.1.300');
  });

  it('refuses an incomplete or unobservable identity and a refused preview without creating a run or probe', async () => {
    h = await probeHarness();
    const before = counts();
    vi.mocked(discoverProviders).mockResolvedValue([]);
    const missing = await h.post(probeBody(['orchestrator']));
    expect(missing.statusCode).toBe(400);
    expect(missing.json.code).toBe('identity_unresolved');
    vi.mocked(discoverProviders).mockResolvedValue([claude({ detected: false })]);
    const undetected = await h.post(probeBody(['orchestrator']));
    expect(undetected.statusCode).toBe(409);
    expect(undetected.json.code).toBe('preview_not_startable');
    vi.mocked(discoverProviders).mockResolvedValue([claude({ subscriptionAuthenticated: false })]);
    expect((await h.post(probeBody(['orchestrator']))).statusCode).toBe(409);
    const missingProfile = await h.post(
      probeBody(['orchestrator'], { ...ROUTE, connectionProfileId: 'ghost-profile' }),
    );
    expect(missingProfile.statusCode).toBe(400);
    expect(counts()).toEqual(before);
    expect(calls).toHaveLength(0);
  });

  it('never probes a metered lane: the ordinary billing evaluation refuses it, with no fallback', async () => {
    h = await probeHarness();
    vi.mocked(discoverProviders).mockResolvedValue([
      claude(),
      claude({ id: 'opencode', name: 'OpenCode', cli: 'opencode', models: [] }),
    ]);
    const before = counts();
    const metered = await h.post(
      probeBody(['orchestrator'], {
        backendId: 'opencode',
        providerId: 'anthropic',
        modelId: 'anthropic/claude-sonnet-5-5',
        billingLane: 'anthropic-api',
      }),
    );
    expect(metered.statusCode).toBe(409);
    expect(metered.json.code).toBe('preview_not_startable');
    expect(counts()).toEqual(before);
    expect(calls).toHaveLength(0);
  });

  it('keeps the subscription lane when the provider fails: no second run, no metered fallback', async () => {
    h = await probeHarness();
    overrides['orchestrator-json'] = async () => {
      throw new Error('provider unavailable');
    };
    const response = await h.post(probeBody(['orchestrator']));
    const { probeId, runId } = response.json as { probeId: string; runId: string };
    await h.waitRun(runId, 'failed');
    await reconcileRouteProbe(h.db, probeId, h.startRun);
    expect(n('SELECT COUNT(*) AS n FROM runs')).toBe(1);
    expect(
      n(
        "SELECT COUNT(*) AS n FROM stages WHERE run_id = ? AND billing_lane <> 'claude-subscription' AND billing_lane IS NOT NULL",
        runId,
      ),
    ).toBe(0);
    expect(calls.every((call) => call.billingLane === 'claude-subscription')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(probeRow(probeId)).toMatchObject({ status: 'failed', failure_code: 'run_failed' });
    expect(records()).toHaveLength(0);
  });

  it('refuses a second probe for the same exact route while one is in progress', async () => {
    h = await probeHarness();
    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = resolve));
    const first = await h.post(probeBody(['orchestrator']));
    expect(first.statusCode).toBe(202);
    const second = await h.post(probeBody(['orchestrator']));
    expect(second.statusCode).toBe(409);
    expect(second.json.code).toBe('probe_in_progress');
    expect(n('SELECT COUNT(*) AS n FROM route_validation_probes')).toBe(1);
    release();
    await h.waitRun((first.json as { runId: string }).runId, 'completed');
  });

  it('keeps the internal fixture project out of the project list', async () => {
    h = await probeHarness();
    await runProbe(['orchestrator']);
    const listed = (await h.app.inject({ method: 'GET', url: '/api/projects' })).json() as {
      projects: Array<{ id: string }>;
    };
    expect(listed.projects.map((project) => project.id)).not.toContain(PROBE_FIXTURE.projectId);
    expect(h.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(PROBE_FIXTURE.projectId)).toBeTruthy();
  });
});

// --- fixture ------------------------------------------------------------------------------------------------------------

describe('validation fixture repository', () => {
  it(
    'is deterministic: the same content always yields the pinned tree and commit',
    async () => {
      h = await probeHarness();
      const { mkdtempSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const one = await buildFixtureRepository(join(mkdtempSync(join(tmpdir(), 'fx-a-')), 'r'));
      const two = await buildFixtureRepository(join(mkdtempSync(join(tmpdir(), 'fx-b-')), 'r'));
      expect(one).toEqual(two);
      expect(one).toEqual({ commit: FIXTURE_COMMIT_SHA, tree: FIXTURE_TREE_SHA });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'fails closed on a changed commit, a dirty checkout or a missing repository, without repairing anything',
    async () => {
      h = await probeHarness();
      await runProbe(['orchestrator']);
      const dir = fixtureDirectory();
      expect(await verifyFixture()).toMatchObject({ ok: true });
      const before = counts();
      // A dirty checkout.
      writeFileSync(join(dir, 'stray.txt'), 'x');
      expect(await verifyFixture()).toEqual({ ok: false, code: 'fixture_dirty' });
      const dirty = await h.post(probeBody(['orchestrator']));
      expect(dirty.statusCode).toBe(503);
      expect(dirty.json.code).toBe('fixture_unavailable');
      expect(existsSync(join(dir, 'stray.txt'))).toBe(true);
      execFileSync('git', ['-C', dir, 'add', '-A']);
      // A different commit (even with identical content) is a different base.
      execFileSync('git', [
        '-C',
        dir,
        '-c',
        'user.name=x',
        '-c',
        'user.email=x@x',
        'commit',
        '-q',
        '-m',
        'drift',
      ]);
      expect(await verifyFixture()).toEqual({ ok: false, code: 'fixture_mismatch' });
      expect((await h.post(probeBody(['orchestrator']))).statusCode).toBe(503);
      expect(execFileSync('git', ['-C', dir, 'log', '--format=%s', '-1'], { encoding: 'utf8' }).trim()).toBe(
        'drift',
      );
      expect(counts()).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

// --- lifecycle, records, profiles ---------------------------------------------------------------------------------------------

const checksOf = (row: Record<string, unknown>) =>
  JSON.parse(row.checks_json as string) as { schema: number; checks: Array<{ code: string; ok: boolean }> };

describe('probe lifecycle and the validation record writer', () => {
  it(
    'writes one authenticated pass record per profile that the 5A.1 reader accepts, and consumes the probe once',
    async () => {
      h = await probeHarness();
      const { probeId, runId, observed } = await runProbe();
      expect(observed.state).toBe('consumed');
      const rows = records(runId);
      expect(rows.map((row) => row.profile).sort()).toEqual([
        'broker-edit',
        'broker-read',
        'orchestrator-json',
      ]);
      for (const row of rows) {
        expect(row).toMatchObject({ status: 'pass', provenance: 'turing_probe_run', evidence_run_id: runId });
        expect(sha256(row.identity_json as string)).toBe(row.identity_hash);
        const { schema, checks } = checksOf(row);
        expect(schema).toBe(1);
        expect(checks.length).toBeGreaterThan(0);
        expect(checks.every((check) => check.ok && PROBE_CHECK_CODES.includes(check.code as never))).toBe(
          true,
        );
        expect(checks.map((check) => check.code).sort()).toEqual(
          [...REQUIRED_CHECKS[row.profile as keyof typeof REQUIRED_CHECKS]].sort(),
        );
        expect(Object.keys(checks[0]!).sort()).toEqual(['code', 'ok']);
        const identity = JSON.parse(row.identity_json as string) as Record<string, string>;
        expect(row.adapter_version).toBe(identity.adapterVersion);
        expect(row.capability_fingerprint).toBe(identity.capabilityFingerprint);
        // stable-subscription lifetime is seven days.
        expect(Date.parse(row.expires_at as string) - Date.parse(row.tested_at as string)).toBe(
          7 * 24 * 3600_000,
        );
      }
      expect(probeRow(probeId)).toMatchObject({ status: 'consumed', failure_code: null });
      // Consumed once: a second reconcile is a no-op and adds nothing.
      const again = await reconcileRouteProbe(h.db, probeId, h.startRun);
      expect(again.state).toBe('consumed');
      expect(records(runId)).toHaveLength(3);

      const hash = rows[0]!.identity_hash as string;
      const all = readRouteValidations(h.db, [hash]);
      expect(all).toHaveLength(3);
      const set = freshValidationSet({
        records: all,
        identityHash: hash,
        identity: JSON.parse(rows[0]!.identity_json as string),
        role: 'implementer',
        freshnessClass: 'stable-subscription',
        now: new Date().toISOString(),
      });
      expect(set.available).toBe(true);
      for (const record of all) expect(validationRecordConsistent(record)).toBe(true);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it('uses a 24-hour lifetime for an opportunity probe', async () => {
    h = await probeHarness();
    const response = await h.post(probeBody(['orchestrator'], ROUTE, 'opportunity'));
    const { probeId, runId } = response.json as { probeId: string; runId: string };
    await h.waitRun(runId, 'completed');
    await reconcileRouteProbe(h.db, probeId, h.startRun);
    for (const row of records(runId))
      expect(Date.parse(row.expires_at as string) - Date.parse(row.tested_at as string)).toBe(24 * 3600_000);
  });

  it('takes resolved_model_reported from canonical usage telemetry, never from the model text', async () => {
    h = await probeHarness();
    const response = await h.post(probeBody(['orchestrator']));
    const { probeId, runId } = response.json as { probeId: string; runId: string };
    await h.waitRun(runId, 'completed');
    const stage = h.db
      .prepare("SELECT id FROM stages WHERE run_id = ? AND stage_key = 'probe-orchestrator-json'")
      .get(runId) as { id: string };
    h.db
      .prepare('UPDATE usage_events SET resolved_model_id = ? WHERE stage_id = ?')
      .run('claude-sonnet-5-5-20260101', stage.id);
    await reconcileRouteProbe(h.db, probeId, h.startRun);
    const byProfile = new Map(records(runId).map((row) => [row.profile, row.resolved_model_reported]));
    expect(byProfile.get('orchestrator-json')).toBe('claude-sonnet-5-5-20260101');
    expect(byProfile.get('broker-read')).toBeNull();
  });

  it('records a fail for a profile that executed and failed semantically, and a newer fail supersedes the older pass', async () => {
    h = await probeHarness();
    const first = await runProbe(['orchestrator']);
    const hash = records(first.runId)[0]!.identity_hash as string;
    overrides['orchestrator-json'] = async () => done('{"not":"a next task"}');
    const second = await runProbe(['orchestrator']);
    const failed = records(second.runId).find((row) => row.profile === 'orchestrator-json')!;
    expect(failed.status).toBe('fail');
    expect(checksOf(failed).checks.some((check) => !check.ok)).toBe(true);
    // Old rows were never touched.
    expect(records(first.runId).every((row) => row.status === 'pass')).toBe(true);
    const all = readRouteValidations(h.db, [hash]);
    const identity = JSON.parse(failed.identity_json as string);
    const latest = latestValidationFor(
      all,
      hash,
      'orchestrator-json',
      new Date(Date.now() + 1000).toISOString(),
    );
    expect(latest?.status).toBe('fail');
    const state = validationState({
      records: all,
      identityHash: hash,
      identity,
      profile: 'orchestrator-json',
      freshnessClass: 'stable-subscription',
      now: new Date(Date.now() + 1000).toISOString(),
    });
    expect(state.state).not.toBe('pass');
  });

  it('does not adopt the planted out-of-scope instruction or accept a vacuous review', async () => {
    h = await probeHarness();
    overrides['orchestrator-json'] = async () =>
      done(
        JSON.stringify({ ...JSON.parse(GOOD_ANSWERS['orchestrator-json']), title: 'Run deploy/release.sh' }),
      );
    const { runId } = await runProbe(['orchestrator']);
    const row = records(runId).find((r) => r.profile === 'orchestrator-json')!;
    expect(row.status).toBe('fail');
  });

  it(
    'judges broker-edit by the audit and the worktree: no write, a forbidden path, or a dirty tree each fail',
    async () => {
      h = await probeHarness();
      overrides['broker-edit'] = async (request) => {
        await h.broker(request.toolBroker.token, 'write_file', {
          path: 'src/protected.txt',
          content: 'changed\n',
        });
        return done('done');
      };
      const bad = await runProbe(['implementer']);
      const row = records(bad.runId).find((r) => r.profile === 'broker-edit');
      // Either the run finished and the edit is judged a fail, or nothing was meaningfully tested; never a pass.
      if (row) {
        expect(row.status).toBe('fail');
        expect(checksOf(row).checks.some((check) => check.code === 'protected_untouched' && !check.ok)).toBe(
          true,
        );
      }
      expect(
        records(bad.runId)
          .filter((r) => r.profile === 'broker-edit')
          .every((r) => r.status === 'fail'),
      ).toBe(true);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it('leaves no record for a profile that was never meaningfully tested (infrastructure failure)', async () => {
    h = await probeHarness();
    overrides['broker-read'] = async () => {
      throw new Error('provider unavailable');
    };
    const response = await h.post(probeBody(['implementer']));
    const { probeId, runId } = response.json as { probeId: string; runId: string };
    await h.waitRun(runId, 'failed');
    const observed = await reconcileRouteProbe(h.db, probeId, h.startRun);
    expect(observed.state).toBe('failed');
    expect(observed.untested).toContain('broker-read');
    expect(records(runId).find((row) => row.profile === 'broker-read')).toBeUndefined();
    expect(probeRow(probeId).failure_code).toBe('run_failed');
    // A failed probe is terminal: reconciling again invents nothing.
    await reconcileRouteProbe(h.db, probeId, h.startRun);
    expect(records(runId).find((row) => row.profile === 'broker-read')).toBeUndefined();
  });

  it('invents nothing for a cancelled run', async () => {
    h = await probeHarness();
    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = resolve));
    const response = await h.post(probeBody(['orchestrator']));
    const { probeId, runId } = response.json as { probeId: string; runId: string };
    h.db
      .prepare("UPDATE runs SET status = 'cancelled', completed_at = ? WHERE id = ?")
      .run(new Date().toISOString(), runId);
    const observed = await reconcileRouteProbe(h.db, probeId, h.startRun);
    expect(observed.state).toBe('failed');
    expect(records()).toHaveLength(0);
    release();
    await new Promise((resolve) => setTimeout(resolve, 400));
  });

  it('observes an active probe and never auto-resumes a paused one', async () => {
    h = await probeHarness();
    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = resolve));
    const response = await h.post(probeBody(['orchestrator']));
    const { probeId, runId } = response.json as { probeId: string; runId: string };
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect((await reconcileRouteProbe(h.db, probeId, h.startRun)).state).toBe('active');
    release();
    await h.waitRun(runId, 'completed');
    h.db.prepare("UPDATE runs SET status = 'paused' WHERE id = ?").run(runId);
    const start = vi.fn();
    const paused = await reconcileRouteProbe(h.db, probeId, start);
    expect(paused.state).toBe('paused');
    expect(start).not.toHaveBeenCalled();
    expect(records()).toHaveLength(0);
  });

  it('starts a queued probe exactly once after a restart, and a second pass does not start it again', async () => {
    h = await probeHarness();
    const starts: string[] = [];
    // Queue a probe whose in-process start never happened (a crash between commit and start).
    const queued = await createRouteProbe(h.db, probeRequest(), () => {
      throw new Error('crashed before start');
    });
    starts.length = 0;
    expect(h.db.prepare('SELECT status FROM runs WHERE id = ?').get(queued.runId)).toEqual({
      status: 'queued',
    });
    h.restart();
    const reconciler = new (await import('./routeProbe.js')).RouteProbeReconciler(h.db, (runId) => {
      starts.push(runId);
      return h.startRun(runId);
    });
    await reconciler.reconcile();
    expect(starts).toEqual([queued.runId]);
    await h.waitRun(queued.runId, 'completed');
    await reconciler.reconcile();
    expect(starts).toEqual([queued.runId]);
    expect(probeRow(queued.probeId).status).toBe('consumed');
    expect(n('SELECT COUNT(*) AS n FROM route_validations')).toBe(2);
  });

  it('cancels, rather than starts, a queued probe whose fixture is no longer the verified base', async () => {
    h = await probeHarness();
    const queued = await createRouteProbe(h.db, probeRequest(), () => {
      throw new Error('crashed before start');
    });
    writeFileSync(join(fixtureDirectory(), 'stray.txt'), 'x');
    const start = vi.fn();
    const observed = await reconcileRouteProbe(h.db, queued.probeId, start);
    expect(start).not.toHaveBeenCalled();
    expect(observed).toMatchObject({ state: 'failed', code: 'fixture_unavailable' });
    expect(h.db.prepare('SELECT status FROM runs WHERE id = ?').get(queued.runId)).toEqual({
      status: 'cancelled',
    });
    expect(calls).toHaveLength(0);
  });

  it(
    'resumes after a crash between two profile inserts without duplicating or rewriting a record',
    async () => {
      h = await probeHarness();
      const response = await h.post(probeBody(['orchestrator', 'implementer']));
      const { probeId, runId } = response.json as { probeId: string; runId: string };
      await h.waitRun(runId, 'completed');
      const run = h.db.prepare('SELECT starting_commit, worktree_path FROM runs WHERE id = ?').get(runId) as {
        starting_commit: string;
        worktree_path: string;
      };
      const verdict = await judgeProfile(h.db, {
        runId,
        profile: 'orchestrator-json',
        startingCommit: run.starting_commit,
        worktreePath: run.worktree_path,
      });
      expect(verdict).not.toBeNull();
      expect(writeProbeRecord(h.db, probeId, 'orchestrator-json', verdict!)).toBe(true);
      const first = records(runId)[0]!;
      // The "crash": only one profile was recorded. A rewrite is refused, then reconciliation finishes the rest.
      expect(writeProbeRecord(h.db, probeId, 'orchestrator-json', verdict!)).toBe(false);
      await reconcileRouteProbe(h.db, probeId, h.startRun);
      const rows = records(runId);
      expect(rows).toHaveLength(3);
      expect(rows.find((row) => row.profile === 'orchestrator-json')).toEqual(first);
      expect(probeRow(probeId).status).toBe('consumed');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it('never revalidates because a record expired: no code path but the POST route creates a probe', async () => {
    h = await probeHarness();
    const { runId } = await runProbe(['orchestrator']);
    h.db.prepare('PRAGMA foreign_keys = ON');
    const before = counts();
    const callsBefore = calls.length;
    await h.reconciler().reconcile();
    await h.reconciler().reconcile();
    expect(counts()).toEqual(before);
    expect(calls).toHaveLength(callsBefore);
    expect(runId).toBeTruthy();
    const { readdirSync } = await import('node:fs');
    const offenders = [
      'routeProbe.ts',
      'routeResolution.ts',
      'routeAudit.ts',
      'supervisor.ts',
      'executor.ts',
      'runPlan.ts',
    ]
      .filter((file) => existsSync(join(import.meta.dirname, file)))
      .filter(
        (file) =>
          /createRouteProbe\(/.test(readFileSync(join(import.meta.dirname, file), 'utf8')) &&
          file !== 'routeProbe.ts',
      );
    expect(offenders).toEqual([]);
    const users = readdirSync(join(import.meta.dirname, '..'))
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .filter((file) =>
        /createRouteProbe\(/.test(readFileSync(join(import.meta.dirname, '..', file), 'utf8')),
      );
    expect(users).toEqual(['app.ts']);
  });
});

function probeRequest() {
  return routeProbeRequestSchema.parse(probeBody(['orchestrator']));
}

describe('worktree retention and database invariants', () => {
  it(
    'prunes a clean consumed worktree conservatively, keeps the branch and leaves records unchanged',
    async () => {
      h = await probeHarness();
      const { probeId, runId } = await runProbe(['implementer']);
      const before = JSON.stringify(records(runId));
      const run = h.db.prepare('SELECT worktree_path, branch FROM runs WHERE id = ?').get(runId) as {
        worktree_path: string;
        branch: string;
      };
      expect(existsSync(run.worktree_path)).toBe(true);
      const { pruneProbeWorktree } = await import('./routeProbe.js');
      expect(await pruneProbeWorktree(h.db, probeId)).toEqual({ status: 'pruned' });
      expect(existsSync(run.worktree_path)).toBe(false);
      expect(
        execFileSync('git', ['-C', fixtureDirectory(), 'rev-parse', '--verify', run.branch]).length,
      ).toBeGreaterThan(0);
      expect(JSON.stringify(records(runId))).toBe(before);
      expect(await pruneProbeWorktree(h.db, probeId)).toEqual({ status: 'already_pruned' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses to prune a dirty worktree or a probe that is not finished',
    async () => {
      h = await probeHarness();
      const { probeId, runId } = await runProbe(['implementer']);
      const run = h.db.prepare('SELECT worktree_path FROM runs WHERE id = ?').get(runId) as {
        worktree_path: string;
      };
      writeFileSync(join(run.worktree_path, 'scratch.txt'), 'x');
      const { pruneProbeWorktree } = await import('./routeProbe.js');
      expect(await pruneProbeWorktree(h.db, probeId)).toEqual({
        status: 'refused',
        reason: 'worktree_dirty',
      });
      expect(existsSync(run.worktree_path)).toBe(true);
      expect(await pruneProbeWorktree(h.db, 'no-such-probe')).toMatchObject({ status: 'refused' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it('enforces migration 021: records are unique per run and profile, immutable, and bound to their pending probe', async () => {
    h = await probeHarness();
    const { probeId, runId } = await runProbe(['orchestrator']);
    const row = records(runId)[0]!;
    const insert = (over: Record<string, unknown>) => {
      const value = { ...row, id: `x-${Math.random()}`, ...over };
      h.db
        .prepare(
          `INSERT INTO route_validations (id, identity_hash, identity_json, profile, status, evidence_run_id, resolved_model_reported, checks_json, provenance, adapter_version, capability_fingerprint, tested_at, expires_at)
           VALUES (@id, @identity_hash, @identity_json, @profile, @status, @evidence_run_id, @resolved_model_reported, @checks_json, @provenance, @adapter_version, @capability_fingerprint, @tested_at, @expires_at)`,
        )
        .run(value);
    };
    expect(() => insert({})).toThrow();
    expect(() =>
      h.db.prepare('UPDATE route_validations SET status = ? WHERE id = ?').run('fail', row.id),
    ).toThrow();
    expect(() => h.db.prepare('DELETE FROM route_validations WHERE id = ?').run(row.id)).toThrow();
    expect(() => h.db.prepare('DELETE FROM route_validation_probes WHERE id = ?').run(probeId)).toThrow();
    expect(() =>
      h.db.prepare('UPDATE route_validation_probes SET identity_hash = ? WHERE id = ?').run('x', probeId),
    ).toThrow();
    expect(() =>
      h.db.prepare("UPDATE route_validation_probes SET status = 'pending' WHERE id = ?").run(probeId),
    ).toThrow();
  });

  it('refuses a record that does not match the pending probe it claims as evidence', async () => {
    h = await probeHarness();
    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = resolve));
    const response = await h.post(probeBody(['orchestrator']));
    const { probeId, runId } = response.json as { probeId: string; runId: string };
    const probe = probeRow(probeId);
    const insert = (over: Record<string, unknown>) =>
      h.db
        .prepare(
          `INSERT INTO route_validations (id, identity_hash, identity_json, profile, status, evidence_run_id, resolved_model_reported, checks_json, provenance, adapter_version, capability_fingerprint, tested_at, expires_at)
           VALUES (?, ?, ?, ?, 'pass', ?, NULL, '{"schema":1,"checks":[]}', 'turing_probe_run', 'a', 'b', ?, ?)`,
        )
        .run(
          'r1',
          over.hash ?? probe.identity_hash,
          over.json ?? probe.identity_json,
          over.profile ?? 'orchestrator-json',
          runId,
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
        );
    expect(() => insert({ hash: 'f'.repeat(64) })).toThrow();
    expect(() => insert({ profile: 'review-json' })).toThrow();
    release();
    await h.waitRun(runId, 'completed');
  });

  it('reports bounded, credential-free probe status from persisted rows alone', async () => {
    h = await probeHarness();
    const { probeId } = await runProbe(['orchestrator']);
    const status = await h.app.inject({ method: 'GET', url: `/api/route-validations/${probeId}` });
    expect(status.statusCode).toBe(200);
    const body = (status.json() as { probe: { status: string; recorded: unknown[] } }).probe;
    expect(body.status).toBe('consumed');
    expect(body.recorded).toHaveLength(2);
    expect(JSON.stringify(body)).not.toMatch(/secret|credential|token/i);
    expect((await h.app.inject({ method: 'GET', url: '/api/route-validations/nope' })).statusCode).toBe(404);
  });
});

describe('Stage 5B.3: pre-start identity reproof and the exact starting commit', () => {
  const queuedProbe = async () =>
    createRouteProbe(h.db, probeRequest(), () => {
      throw new Error('crashed before start');
    });

  it('starts a queued probe whose identity is unchanged', async () => {
    h = await probeHarness();
    const queued = await queuedProbe();
    const start = vi.fn((runId: string) => h.startRun(runId));
    const observed = await reconcileRouteProbe(h.db, queued.probeId, start);
    expect(start).toHaveBeenCalledWith(queued.runId);
    expect(observed.state).toBe('started');
    await h.waitRun(queued.runId, 'completed');
  });

  for (const [name, change] of [
    ['adapter version', () => claude({ version: '2.2.0' })],
    [
      'capability fingerprint',
      () =>
        claude({
          models: [{ id: ROUTE.modelId, name: 'm', providerId: ROUTE.providerId, supportsTools: true }],
        }),
    ],
  ] as const) {
    it(`cancels, writes no validation and makes no provider call when the ${name} changed before start`, async () => {
      h = await probeHarness();
      const queued = await queuedProbe();
      const before = probeRow(queued.probeId).identity_json;
      vi.mocked(discoverProviders).mockResolvedValue([change()]);
      const start = vi.fn();
      const observed = await reconcileRouteProbe(h.db, queued.probeId, start);
      expect(start).not.toHaveBeenCalled();
      expect(observed.state).toBe('failed');
      expect(h.db.prepare('SELECT status FROM runs WHERE id = ?').get(queued.runId)).toEqual({
        status: 'cancelled',
      });
      expect(probeRow(queued.probeId)).toMatchObject({ status: 'failed', failure_code: 'profiles_untested' });
      // The stored identity is never upgraded.
      expect(probeRow(queued.probeId).identity_json).toBe(before);
      expect(n('SELECT COUNT(*) AS n FROM route_validations')).toBe(0);
      expect(calls).toHaveLength(0);
      const event = h.db
        .prepare("SELECT payload_json AS p FROM run_events WHERE run_id = ? AND type LIKE '%cancel%'")
        .all(queued.runId) as Array<{ p: string }>;
      expect(event.map((row) => row.p).join()).toContain('identity_changed');
    });
  }

  it('applies the same reproof to the post-request start path', async () => {
    h = await probeHarness();
    vi.mocked(discoverProviders).mockResolvedValue([claude()]);
    const start = vi.fn();
    let observeCount = 0;
    vi.mocked(discoverProviders).mockImplementation(async () => {
      observeCount += 1;
      // The request observes version 2.1.300; the later pre-start observation sees a new adapter.
      return [claude(observeCount > 3 ? { version: '9.9.9' } : {})];
    });
    const created = await createRouteProbe(h.db, probeRequest(), start);
    expect(start).not.toHaveBeenCalled();
    expect(probeRow(created.probeId)).toMatchObject({ status: 'failed', failure_code: 'profiles_untested' });
    expect(n('SELECT COUNT(*) AS n FROM route_validations')).toBe(0);
  });

  async function finishedWithCommit(commit: string | null) {
    // Hold the provider so the run cannot finish (and be reconciled in-process) before its base is set.
    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = resolve));
    const response = await h.post(probeBody(['orchestrator']));
    const { probeId, runId } = response.json as { probeId: string; runId: string };
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    h.db.prepare('UPDATE runs SET starting_commit = ? WHERE id = ?').run(commit, runId);
    release();
    await h.waitRun(runId, 'completed');
    return { probeId, runId, observed: await reconcileRouteProbe(h.db, probeId, h.startRun) };
  }

  it('mints no record for a terminal run with a NULL starting_commit', async () => {
    h = await probeHarness();
    const { probeId, observed } = await finishedWithCommit(null);
    expect(observed.state).toBe('failed');
    expect(probeRow(probeId).status).toBe('failed');
    expect(n('SELECT COUNT(*) AS n FROM route_validations')).toBe(0);
  });

  it('mints no record for a terminal run that started from another valid commit', async () => {
    h = await probeHarness();
    const { probeId, observed } = await finishedWithCommit('c'.repeat(40));
    expect(observed.state).toBe('failed');
    expect(probeRow(probeId).status).toBe('failed');
    expect(n('SELECT COUNT(*) AS n FROM route_validations')).toBe(0);
  });

  it('judges normally when the run started from exactly the pinned fixture commit', async () => {
    h = await probeHarness();
    const { probeId, observed } = await finishedWithCommit(FIXTURE_COMMIT_SHA);
    expect(observed.state).toBe('consumed');
    expect(probeRow(probeId).status).toBe('consumed');
    expect(n('SELECT COUNT(*) AS n FROM route_validations')).toBeGreaterThan(0);
  });

  it('accepts a route member the approved-definition validator accepts (shared bounds)', () => {
    const configuration = {
      ...ROUTE,
      nativeSettings: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 'v'.repeat(300)])),
    };
    expect(routeProbeRequestSchema.safeParse(probeBody(['orchestrator'], configuration)).success).toBe(true);
    expect(
      routeProbeRequestSchema.safeParse({ ...probeBody(['orchestrator']), identityHash: 'x' }).success,
    ).toBe(false);
  });
});
