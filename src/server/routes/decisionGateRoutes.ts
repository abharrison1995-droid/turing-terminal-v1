import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { decisionEngineInfo, routeDecision, validateDecisionGate } from '../../shared/decisions.js';
import type { DecisionGateConfig } from '../../shared/types.js';
import { decisionConfigHash, decisionEngine, type DecisionContext } from '../decisionEngines.js';
import { createMeteringHooks } from '../metering.js';
import { allProviders } from '../modelCatalog.js';
import { SecretStore, secretRef } from '../secretStore.js';
import { redactSecrets } from '../security.js';
import { message, type RouteContext } from './routeUtils.js';
import { decisionSchema } from './workflowSchemas.js';

export function registerDecisionGateRoutes(app: FastifyInstance, { db }: RouteContext): void {
  // Decision policy test mode: evaluate a Decision Gate configuration against deterministic fixtures.
  app.post('/api/decision-gates/test', async (request, reply) => {
    const parsed = z
      .object({
        decision: decisionSchema,
        fixtures: z
          .array(
            z.object({
              name: z.string().max(120).default(''),
              state: z.record(z.string(), z.unknown()).default({}),
              conditionValues: z
                .record(z.string(), z.union([z.boolean(), z.number(), z.string()]))
                .optional(),
              expected: z.union([z.boolean(), z.string().max(80), z.number()]).optional(),
            }),
          )
          .min(1)
          .max(200),
        billingMode: z
          .enum(['subscriptions-only', 'subscriptions-plus-decision-budget', 'custom'])
          .default('subscriptions-only'),
        maxCostUsd: z.number().finite().min(0).max(10).nullable().default(null),
        confirmExternal: z.boolean().default(false),
      })
      .safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid decision test.' });
    const config = parsed.data.decision as DecisionGateConfig;
    const errors = validateDecisionGate(config, 'Test', []).filter(
      (error) => !error.includes('can only skip later stages'),
    );
    if (errors.length) return reply.code(400).send({ error: errors.join(' ') });
    const external = [config, ...(config.escalation ? [config.escalation] : [])].some(
      (route) => decisionEngineInfo(route.engine).external,
    );
    if (external && !parsed.data.confirmExternal)
      return reply
        .code(400)
        .send({ error: 'Confirm that fixture state may be sent to the external Decision Engine.' });
    const batchId = randomUUID();
    const scope = `decision-test:${batchId}`;
    const openRouterRoutes = new Map<
      string,
      { key: string; model: import('../../shared/types.js').ModelOption | undefined }
    >();
    for (const route of [config, ...(config.escalation ? [config.escalation] : [])]) {
      if (route.engine !== 'jev-openrouter' && route.engine !== 'openrouter-judge') continue;
      const key = route.connectionProfileId
        ? SecretStore.forDatabase(db).read(secretRef(route.connectionProfileId, 'inference'))
        : null;
      if (!key)
        return reply
          .code(400)
          .send({ error: 'Select an OpenRouter connection with a stored inference key.' });
      const status = (await allProviders(db)).find((provider) => provider.id === 'openrouter');
      openRouterRoutes.set(`${route.connectionProfileId}::${route.modelId}`, {
        key,
        model: status?.models.find((model) => model.id === route.modelId),
      });
    }
    const results: Array<Record<string, unknown>> = [];
    let cost = 0;
    let costReported = 0;
    const costProvenances = new Set<string>();
    for (const [index, fixture] of parsed.data.fixtures.entries()) {
      const context: DecisionContext = {
        signal: AbortSignal.timeout(120_000),
        conditionValue: (path) => fixture.conditionValues?.[path] ?? null,
        resolveOpenRouter: (route) => {
          const resolved = openRouterRoutes.get(`${route.connectionProfileId}::${route.modelId}`);
          if (!resolved) throw new Error('OpenRouter route is not configured.');
          return resolved;
        },
        metering: (route, question) =>
          createMeteringHooks(db, {
            usageRunId: null,
            reservationScopeId: scope,
            stageId: null,
            billingMode: parsed.data.billingMode,
            perRunUsd: parsed.data.maxCostUsd,
            unknownCostPolicy: 'block',
            workload: 'decision',
            connectionProfileId: route.connectionProfileId ?? null,
            role: 'decision-test',
            modelId: route.modelId ?? '',
            modelDisplayName: null,
            reasoning: null,
            contextStrategy: 'fixture',
            decisionEngine: route.engine,
            decisionType: question.questionType,
            batchId,
          }),
      };
      try {
        const [decision] = await decisionEngine(config.engine).evaluate(
          [
            {
              id: randomUUID(),
              batchId,
              route: config,
              question: {
                questionId: `fixture_${index}`,
                questionType: config.questionType,
                question: config.question,
                criteria: config.criteria,
                instructions: config.instructions,
              },
              state: fixture.state,
              rule: config.rule,
            },
          ],
          context,
        );
        const routed = routeDecision({ ...decision!, questionType: config.questionType }, config.routing);
        if (decision!.costUsd !== null) {
          cost += decision!.costUsd;
          costReported += 1;
          costProvenances.add(decision!.costProvenance);
        }
        const actual =
          config.questionType === 'boolean'
            ? routed.outcome === 'pass'
              ? true
              : routed.outcome === 'fail'
                ? false
                : null
            : decision!.answer;
        results.push({
          name: fixture.name || `Fixture ${index + 1}`,
          outcome: routed.outcome,
          route: routed.route,
          answer: decision!.answer,
          probability: decision!.probability,
          confidence: decision!.confidence,
          score: decision!.score,
          expected: fixture.expected ?? null,
          correct: fixture.expected === undefined ? null : actual === fixture.expected,
        });
      } catch (error) {
        results.push({
          name: fixture.name || `Fixture ${index + 1}`,
          error: redactSecrets(message(error)).slice(0, 400),
        });
      }
    }
    const scored = results.filter((item) => item.correct !== null && item.correct !== undefined);
    const field = (key: 'probability' | 'confidence') =>
      results.map((item) => item[key]).filter((value): value is number => typeof value === 'number');
    const stats = (values: number[]) =>
      values.length
        ? {
            count: values.length,
            min: Math.min(...values),
            max: Math.max(...values),
            mean: values.reduce((a, b) => a + b, 0) / values.length,
          }
        : null;
    return {
      batchId,
      configHash: decisionConfigHash(config),
      results,
      accuracy: scored.length ? scored.filter((item) => item.correct === true).length / scored.length : null,
      probability: stats(field('probability')),
      confidence: stats(field('confidence')),
      escalationRate: results.length
        ? results.filter((item) => item.outcome === 'uncertain').length / results.length
        : null,
      errors: results.filter((item) => item.error).length,
      actualCostUsd: costReported ? cost : null,
      costProvenance: !costReported
        ? 'unavailable'
        : costProvenances.has('provider_measured')
          ? 'provider_measured'
          : 'locally_measured',
    };
  });
}
