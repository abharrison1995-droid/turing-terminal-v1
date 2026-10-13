import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { goalApp } from './apiKit.js';
import { approveDefinition, createGoalDraft } from './definitions.js';
import { simpleDefinition } from './repoKit.js';

/**
 * GH.1 (S1a): the server refuses PAIRED REMOTE callers (Tailscale identity header plus a paired device cookie) on the five
 * user-only Goal authority routes. The only remote signal is the existing predicate in app.ts. Local callers keep today's
 * behaviour. This does NOT distinguish the desktop UI from another same-user local process (S1b, owner decision pending).
 */

const DESKTOP_REFUSAL = 'desktop_required';
const TAILSCALE_LOGIN = 'alex@example.com';
const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let root = '';
let db: Db;
let app: FastifyInstance;
let seededGoalId = '';

// A Goal seeded directly in a temporary database: no Git repository is created, so this is not a real-Git fixture and
// the shared real-Git timeout does not apply. The guard routes refuse before any Git-backed step.
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'turing-gh1-'));
  db = openDatabase(root);
  const machineId = (
    db.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string }
  ).value;
  const projectId = randomUUID();
  db.prepare(
    "INSERT INTO projects (id, machine_id, name, path, git_root, created_at) VALUES (?, ?, 'P', ?, NULL, '2026-01-01T00:00:00.000Z')",
  ).run(projectId, machineId, root);
  seededGoalId = createGoalDraft(db, { projectId, title: 'G', definition: simpleDefinition() }).goalId;
  approveDefinition(db, { goalId: seededGoalId, version: 1, actor: 'user' });
  app = goalApp(db);
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

interface Call {
  method: 'POST';
  url: string;
  payload: unknown;
}

/** The five guarded routes, addressed by ids that do not exist: the guard must answer before any lookup. */
function desktopOnlyCalls(goalId: string): Call[] {
  return [
    {
      method: 'POST',
      url: `/api/goals/${goalId}/handoffs/handoff-missing/external-integration/attestations/attestation-missing/corrections`,
      payload: {},
    },
    {
      method: 'POST',
      url: `/api/goals/${goalId}/handoffs/handoff-missing/external-integration/attest`,
      payload: {},
    },
    { method: 'POST', url: `/api/goals/${goalId}/completion-decision`, payload: {} },
    { method: 'POST', url: `/api/goals/${goalId}/completion`, payload: {} },
    {
      method: 'POST',
      url: `/api/goals/${goalId}/attestation-corrections/approval-missing/decision`,
      payload: {},
    },
  ];
}

const COUNTED_TABLES = ['goals', 'goal_approvals', 'goal_external_completion_proofs', 'goal_events'] as const;

function snapshot() {
  const counts = Object.fromEntries(
    COUNTED_TABLES.map((table) => [
      table,
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
    ]),
  );
  const goal = db.prepare('SELECT status FROM goals WHERE id = ?').get(seededGoalId);
  return { counts, goal };
}

/** Pairs a remote device through the existing pairing flow and returns its `__Host-turing-device` cookie. */
async function pairRemoteDevice(login: string): Promise<string> {
  const created = await app.inject({ method: 'POST', url: '/api/pairing/requests' });
  expect(created.statusCode).toBe(201);
  const { id: requestId, code } = created.json().request as { id: string; code: string };
  const identity = { 'tailscale-user-login': login };
  const claimed = await app.inject({
    method: 'POST',
    url: '/api/pairing/claim',
    headers: identity,
    payload: { code, deviceName: 'Alex phone' },
  });
  expect(claimed.statusCode).toBe(202);
  const approved = await app.inject({ method: 'POST', url: `/api/pairing/requests/${requestId}/approve` });
  expect(approved.statusCode).toBe(200);
  const completed = await app.inject({
    method: 'POST',
    url: '/api/pairing/complete',
    headers: identity,
    payload: { requestId, code },
  });
  expect(completed.statusCode).toBe(201);
  const setCookie = completed.headers['set-cookie'] as string;
  const cookie = setCookie.split(';')[0]!;
  expect(cookie).toMatch(/^__Host-turing-device=ttd_/);
  return cookie;
}

function expectDesktopRefusal(response: { statusCode: number; body: string }) {
  expect(response.statusCode).toBe(403);
  expect(JSON.parse(response.body)).toMatchObject({ code: DESKTOP_REFUSAL });
}

describe('GH.1 desktop-only Goal authority routes', () => {
  it('(a) local callers are not refused by the desktop guard on the five routes', async () => {
    for (const call of desktopOnlyCalls(seededGoalId)) {
      const response = await app.inject({
        method: call.method,
        url: call.url,
        payload: call.payload as object,
      });
      expect(response.statusCode, call.url).not.toBe(403);
      expect(JSON.parse(response.body).code, call.url).not.toBe(DESKTOP_REFUSAL);
    }
  });

  it('(b) a paired remote device is refused with 403 desktop_required and writes nothing', async () => {
    const cookie = await pairRemoteDevice(TAILSCALE_LOGIN);
    const before = snapshot();
    for (const call of desktopOnlyCalls(seededGoalId)) {
      const response = await app.inject({
        method: call.method,
        url: call.url,
        payload: call.payload as object,
        headers: { 'tailscale-user-login': TAILSCALE_LOGIN, cookie },
      });
      expectDesktopRefusal(response);
    }
    expect(snapshot()).toEqual(before);
  });

  it('(b) the guard runs before body validation: an invalid body is still desktop_required', async () => {
    const cookie = await pairRemoteDevice(TAILSCALE_LOGIN);
    const headers = { 'tailscale-user-login': TAILSCALE_LOGIN, cookie };
    const invalid = { unexpected: true, attestationId: 42 };
    for (const call of desktopOnlyCalls(seededGoalId)) {
      const response = await app.inject({ method: call.method, url: call.url, payload: invalid, headers });
      expectDesktopRefusal(response);
    }
  });

  it('(c) the same paired device keeps its mobile-permitted reads and ordinary controls', async () => {
    const cookie = await pairRemoteDevice(TAILSCALE_LOGIN);
    const headers = { 'tailscale-user-login': TAILSCALE_LOGIN, cookie };

    const detail = await app.inject({ method: 'GET', url: `/api/goals/${seededGoalId}`, headers });
    expect(detail.statusCode).toBe(200);

    const preflight = await app.inject({
      method: 'GET',
      url: `/api/goals/${seededGoalId}/completion-preflight`,
      headers,
    });
    expect(preflight.statusCode).not.toBe(403);
    expect(JSON.parse(preflight.body).code).not.toBe(DESKTOP_REFUSAL);

    const history = await app.inject({
      method: 'GET',
      url: `/api/goals/${seededGoalId}/handoffs/handoff-missing/external-integration/attestations/attestation-missing/corrections`,
      headers,
    });
    expect(history.statusCode).not.toBe(403);
    expect(JSON.parse(history.body).code).not.toBe(DESKTOP_REFUSAL);

    const unified = await app.inject({ method: 'GET', url: '/api/approvals/unified', headers });
    expect(unified.statusCode).toBe(200);

    const decision = await app.inject({
      method: 'POST',
      url: '/api/goal-approvals/approval-missing/decision',
      payload: { decision: 'approved' },
      headers,
    });
    expect(decision.statusCode).not.toBe(403);
    expect(JSON.parse(decision.body).code).not.toBe(DESKTOP_REFUSAL);

    const pause = await app.inject({
      method: 'POST',
      url: `/api/goals/${seededGoalId}/pause`,
      payload: {},
      headers,
    });
    expect(pause.statusCode).not.toBe(403);
    expect(JSON.parse(pause.body).code).not.toBe(DESKTOP_REFUSAL);
  });

  it('(d) an identity header without the device cookie is still 401, not 403', async () => {
    for (const call of desktopOnlyCalls(seededGoalId)) {
      const response = await app.inject({
        method: call.method,
        url: call.url,
        payload: call.payload as object,
        headers: { 'tailscale-user-login': TAILSCALE_LOGIN },
      });
      expect(response.statusCode, call.url).toBe(401);
    }
  });

  it('(e) a non-loopback Origin without an identity header is still 401', async () => {
    for (const call of desktopOnlyCalls(seededGoalId)) {
      const response = await app.inject({
        method: call.method,
        url: call.url,
        payload: call.payload as object,
        headers: { origin: 'https://attacker.example' },
      });
      expect(response.statusCode, call.url).toBe(401);
    }
  });

  it('(f) spoofed desktop-looking headers do not turn a paired remote request into a desktop request', async () => {
    const cookie = await pairRemoteDevice(TAILSCALE_LOGIN);
    const spoofed = {
      'tailscale-user-login': TAILSCALE_LOGIN,
      cookie,
      'x-forwarded-for': '127.0.0.1',
      'user-agent': DESKTOP_CHROME_UA,
      'x-device-type': 'desktop',
      'sec-ch-ua-mobile': '?0',
      host: 'localhost:4317',
      origin: 'http://localhost:4317',
    };
    for (const call of desktopOnlyCalls(seededGoalId)) {
      const response = await app.inject({
        method: call.method,
        url: call.url,
        payload: call.payload as object,
        headers: spoofed,
      });
      expectDesktopRefusal(response);
    }
  });
});

/**
 * Drift guard (static, text-based). Route registrations are found with a regular expression over the source text, not by
 * running the router. Each handler body is the text from its registration to the next registration. The check is
 * therefore a text check, not a semantic proof; it fails closed on any unclassified non-GET route.
 */
describe('GH.1 drift guard over goalRoutes.ts', () => {
  const source = readFileSync(new URL('./goalRoutes.ts', import.meta.url), 'utf8');

  // Keyed "METHOD path". Exactly these five may call requireDesktopCaller, and each must call it before any body or reply use.
  const DESKTOP_ONLY = new Set([
    'POST /api/goals/:goalId/handoffs/:handoffId/external-integration/attestations/:attestationId/corrections',
    'POST /api/goals/:goalId/handoffs/:handoffId/external-integration/attest',
    'POST /api/goals/:goalId/completion-decision',
    'POST /api/goals/:goalId/completion',
    'POST /api/goals/:goalId/attestation-corrections/:approvalId/decision',
  ]);

  // Every other non-GET route, which must NOT call requireDesktopCaller.
  const MOBILE_OR_LOCAL = new Set([
    'POST /api/goals/:goalId/handoffs',
    'POST /api/goals',
    'PUT /api/goals/:goalId/definitions/:version',
    'POST /api/goals/:goalId/definitions',
    'POST /api/goals/:goalId/definitions/:version/approve',
    'POST /api/goals/:goalId/definitions/:version/reject',
    'POST /api/goals/:goalId/start',
    'POST /api/goals/:goalId/resume',
    'POST /api/goals/:goalId/pause',
    'POST /api/goals/:goalId/abandon',
    'POST /api/goals/:goalId/findings/:findingId/decision',
    'POST /api/goal-approvals/:approvalId/decision',
  ]);

  const registrations = [...source.matchAll(/app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)].map(
    (match) => ({
      method: match[1]!.toUpperCase(),
      path: match[2]!,
      key: `${match[1]!.toUpperCase()} ${match[2]!}`,
      index: match.index ?? -1,
    }),
  );
  const nonGet = registrations.filter((route) => route.method !== 'GET');
  const handlerBody = (index: number) => {
    const next = registrations.find((route) => route.index > index);
    return source.slice(index, next ? next.index : source.length);
  };

  it('extracts every route registration (no registration is skipped by the text match)', () => {
    const rawCount = source.match(/app\.(get|post|put|patch|delete)\(/g)?.length ?? 0;
    expect(registrations.length).toBe(rawCount);
    expect(nonGet.length).toBeGreaterThan(0);
  });

  it('classifies every non-GET route in exactly one list, with no stale entries', () => {
    const keys = nonGet.map((route) => route.key);
    const unclassified = keys.filter((key) => !DESKTOP_ONLY.has(key) && !MOBILE_OR_LOCAL.has(key));
    const overlapping = keys.filter((key) => DESKTOP_ONLY.has(key) && MOBILE_OR_LOCAL.has(key));
    const stale = [...DESKTOP_ONLY, ...MOBILE_OR_LOCAL].filter((key) => !keys.includes(key));
    expect(unclassified).toEqual([]);
    expect(overlapping).toEqual([]);
    expect(stale).toEqual([]);
    expect(DESKTOP_ONLY.size + MOBILE_OR_LOCAL.size).toBe(nonGet.length);
  });

  it('every DESKTOP_ONLY handler calls requireDesktopCaller(request) before any body parse or reply use', () => {
    for (const route of nonGet.filter((r) => DESKTOP_ONLY.has(r.key))) {
      const body = handlerBody(route.index);
      const guard = body.indexOf('requireDesktopCaller(request)');
      const firstUse = body.search(/reply\.|[pP]arse|request\.body/);
      expect(guard, route.key).toBeGreaterThan(-1);
      expect(firstUse === -1 || guard < firstUse, route.key).toBe(true);
    }
  });

  it('no MOBILE_OR_LOCAL handler calls requireDesktopCaller', () => {
    for (const route of nonGet.filter((r) => MOBILE_OR_LOCAL.has(r.key))) {
      expect(handlerBody(route.index), route.key).not.toContain('requireDesktopCaller(');
    }
  });

  it('the file calls requireDesktopCaller exactly five times (one per DESKTOP_ONLY route)', () => {
    expect(source.split('requireDesktopCaller(').length - 1).toBe(DESKTOP_ONLY.size);
  });
});
