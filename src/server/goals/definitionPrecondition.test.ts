import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { call, goalApp } from './apiKit.js';
import {
  editProposedDefinition,
  approveDefinition,
  rejectDefinition,
  parseDefinitionPrecondition,
} from './definitions.js';
import { cleanupRepoFixtures, milestone, simpleDefinition, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';
import { harness, type Harness } from './supervisorKit.js';
import { GOAL_WORKFLOW_IDS } from '../../shared/goalWorkflows.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  cleanupRepoFixtures();
});

const quote = (hash: string) => `"${hash}"`;
const send = (h: Harness, method: 'PUT' | 'POST', path: string, body: unknown, header?: string) =>
  call(
    app!,
    method,
    `/api/goals/${h.fx.goalId}/definitions/${path}`,
    body,
    header === undefined ? {} : { 'if-match': header },
  );
const stored = (h: Harness, version = 2) =>
  h.fx.db
    .prepare(
      'SELECT status, definition_hash AS hash, limits_json FROM goal_definition_versions WHERE goal_id = ? AND version = ?',
    )
    .get(h.fx.goalId, version) as { status: string; hash: string; limits_json: string };
const count = (h: Harness, sql: string) => (h.fx.db.prepare(sql).get() as { n: number }).n;

/** A ready Goal with a proposed v2 (a valid revision). Returns the document and its hash AAA. */
async function withProposal() {
  const h = harness({ definition: simpleDefinition({ milestones: [milestone('m1', ['build', 'tests'])] }) });
  app = goalApp(h.fx.db, h.supervisor);
  const read = await call(app, 'GET', `/api/goals/${h.fx.goalId}/definitions/1`);
  const doc = structuredClone(read.body.definition.definition);
  doc.routing.workflows = {
    planning: GOAL_WORKFLOW_IDS.planning,
    execution: GOAL_WORKFLOW_IDS.execution,
    review: GOAL_WORKFLOW_IDS.review,
    verification: GOAL_WORKFLOW_IDS.verification,
  };
  const begun = await call(app, 'POST', `/api/goals/${h.fx.goalId}/definitions`, { definition: doc });
  expect(begun.status).toBe(201);
  return { h, doc, aaa: begun.body.definitionHash as string };
}
const changed = (doc: { limits: { maxExecutionCycles: number } }, cycles: number) => ({
  ...doc,
  limits: { ...doc.limits, maxExecutionCycles: cycles },
});

describe('definition mutations are bound to the persisted hash the caller reviewed', () => {
  it('parses only a single strong 64-hex entity tag', () => {
    const hash = 'ab'.repeat(32);
    expect(parseDefinitionPrecondition(quote(hash))).toBe(hash);
    for (const bad of [
      undefined,
      '',
      '*',
      `W/${quote(hash)}`,
      hash,
      `${quote(hash)}, ${quote(hash)}`,
      '"abc"',
      quote(hash.toUpperCase()),
    ])
      expect(() => parseDefinitionPrecondition(bad as string)).toThrow(
        expect.objectContaining({ code: 'definition_precondition_required' }),
      );
  });

  it(
    'missing or malformed If-Match refuses Save, Approve and Reject with 428 and changes nothing',
    async () => {
      const { h, doc, aaa } = await withProposal();
      for (const header of [undefined, '*', `W/${quote(aaa)}`, 'nonsense']) {
        for (const [method, path, body] of [
          ['PUT', '2', { definition: changed(doc, 77) }],
          ['POST', '2/approve', {}],
          ['POST', '2/reject', {}],
        ] as const) {
          const response = await call(
            app!,
            method,
            `/api/goals/${h.fx.goalId}/definitions/${path}`,
            body,
            header === undefined ? {} : { 'if-match': header },
          );
          expect(response.status).toBe(428);
          expect(response.body.code).toBe('definition_precondition_required');
        }
      }
      expect(stored(h)).toMatchObject({ status: 'proposed', hash: aaa });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'stale Save is refused with 412 and cannot overwrite the newer persisted proposal',
    async () => {
      const { h, doc, aaa } = await withProposal();
      const bbb = (await send(h, 'PUT', '2', { definition: changed(doc, 31) }, quote(aaa))).body.definition
        .definitionHash;
      expect(bbb).not.toBe(aaa);
      const events = count(h, 'SELECT COUNT(*) AS n FROM goal_events');
      const stale = await send(
        h,
        'PUT',
        '2',
        { definition: changed(doc, 99), changeSummary: 'stale' },
        quote(aaa),
      );
      expect(stale.status).toBe(412);
      expect(stale.body.code).toBe('definition_precondition_failed');
      const row = h.fx.db
        .prepare(
          'SELECT definition_hash AS hash, limits_json, change_summary FROM goal_definition_versions WHERE goal_id = ? AND version = 2',
        )
        .get(h.fx.goalId) as { hash: string; limits_json: string; change_summary: string };
      expect(row.hash).toBe(bbb);
      expect(row.limits_json).toContain('31');
      expect(row.change_summary).not.toBe('stale');
      expect(count(h, 'SELECT COUNT(*) AS n FROM goal_events')).toBe(events);
      // the current hash succeeds
      expect((await send(h, 'PUT', '2', { definition: changed(doc, 32) }, quote(bbb))).status).toBe(200);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'stale Approve is refused and creates or decides no approval, definition change or Goal change',
    async () => {
      const { h, doc, aaa } = await withProposal();
      await send(h, 'PUT', '2', { definition: changed(doc, 31) }, quote(aaa));
      const before = {
        approvals: count(h, 'SELECT COUNT(*) AS n FROM goal_approvals'),
        events: count(h, 'SELECT COUNT(*) AS n FROM goal_events'),
        goal: h.fx.db
          .prepare('SELECT status, status_reason_code, current_definition_version FROM goals')
          .get(),
        v1: stored(h, 1).status,
      };
      const stale = await send(h, 'POST', '2/approve', {}, quote(aaa));
      expect(stale.status).toBe(412);
      expect(stale.body.code).toBe('definition_precondition_failed');
      expect(stored(h).status).toBe('proposed');
      expect(stored(h, 1).status).toBe(before.v1);
      expect(count(h, 'SELECT COUNT(*) AS n FROM goal_approvals')).toBe(before.approvals);
      expect(count(h, 'SELECT COUNT(*) AS n FROM goal_events')).toBe(before.events);
      expect(
        h.fx.db.prepare('SELECT status, status_reason_code, current_definition_version FROM goals').get(),
      ).toEqual(before.goal);
      const current = stored(h).hash;
      expect((await send(h, 'POST', '2/approve', {}, quote(current))).status).toBe(200);
      expect(stored(h).status).toBe('approved');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'stale Reject leaves the proposal and Goal untouched with no rejection event; the current hash rejects',
    async () => {
      const { h, doc, aaa } = await withProposal();
      await send(h, 'PUT', '2', { definition: changed(doc, 31) }, quote(aaa));
      const goal = h.fx.db.prepare('SELECT status, status_reason_code FROM goals').get();
      const stale = await send(h, 'POST', '2/reject', {}, quote(aaa));
      expect(stale.status).toBe(412);
      expect(stored(h).status).toBe('proposed');
      expect(count(h, "SELECT COUNT(*) AS n FROM goal_events WHERE type = 'definition_rejected'")).toBe(0);
      expect(h.fx.db.prepare('SELECT status, status_reason_code FROM goals').get()).toEqual(goal);
      expect((await send(h, 'POST', '2/reject', {}, quote(stored(h).hash))).status).toBe(200);
      expect(stored(h).status).toBe('rejected');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'is checked inside the mutation transaction against the row the transaction loaded',
    async () => {
      const { h, doc, aaa } = await withProposal();
      // Domain level: a stale expected hash throws before any write, whatever route read earlier.
      expect(() =>
        editProposedDefinition(h.fx.db, {
          goalId: h.fx.goalId,
          version: 2,
          expectedDefinitionHash: 'f'.repeat(64),
          definition: changed(doc, 5),
        }),
      ).toThrow(expect.objectContaining({ code: 'definition_precondition_failed' }));
      expect(() =>
        rejectDefinition(h.fx.db, {
          goalId: h.fx.goalId,
          version: 2,
          expectedDefinitionHash: 'f'.repeat(64),
          actor: 'user',
        }),
      ).toThrow(expect.objectContaining({ code: 'definition_precondition_failed' }));
      expect(() =>
        approveDefinition(h.fx.db, {
          goalId: h.fx.goalId,
          version: 2,
          expectedDefinitionHash: 'f'.repeat(64),
          actor: 'user',
        }),
      ).toThrow(expect.objectContaining({ code: 'definition_precondition_failed' }));
      expect(stored(h).hash).toBe(aaa);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'keeps definition_hash_mismatch (corrupt stored content) distinct from a stale precondition',
    async () => {
      const { h, aaa } = await withProposal();
      h.fx.db
        .prepare('UPDATE goal_definition_versions SET definition_hash = ? WHERE goal_id = ? AND version = 2')
        .run('c'.repeat(64), h.fx.goalId);
      const response = await send(h, 'POST', '2/approve', {}, quote('c'.repeat(64)));
      expect(response.body.code).toBe('definition_hash_mismatch');
      expect(aaa).not.toBe('c'.repeat(64));
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
