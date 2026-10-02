import type {
  DecisionEngineId,
  DecisionGateConfig,
  DecisionOutcome,
  DecisionResult,
  DecisionRouteAction,
  DecisionRoutingPolicy,
} from './types.js';

export const DECISION_SCHEMA_VERSION = 1;
export const DEFAULT_JEV_MODEL = 'typesafe/jev-1.13';

export const DECISION_ENGINES: Array<{ id: DecisionEngineId; label: string; external: boolean; metered: boolean }> = [
  { id: 'deterministic-rules', label: 'Deterministic Rules', external: false, metered: false },
  { id: 'jev-openrouter', label: 'Jev via OpenRouter Decisions', external: true, metered: true },
  { id: 'subscription-llm-judge', label: 'Subscription LLM Judge', external: true, metered: false },
  { id: 'openrouter-judge', label: 'OpenRouter generative judge', external: true, metered: true },
];

export function decisionEngineInfo(engine: DecisionEngineId) {
  return DECISION_ENGINES.find((item) => item.id === engine) ?? DECISION_ENGINES[0]!;
}

export interface RoutedDecision {
  outcome: DecisionOutcome;
  route: DecisionRouteAction & { reason: string };
}

type RoutableResult = Pick<DecisionResult, 'questionType' | 'answer' | 'probability' | 'confidence' | 'score' | 'distribution'>;

const fmt = (value: number) => (Math.round(value * 1_000) / 1_000).toString();

/**
 * Apply a routing policy to a structured decision. Thresholds read the explicitly named field only;
 * a missing field is UNCERTAIN, never substituted with another field and never forced into PASS/FAIL.
 */
export function routeDecision(result: RoutableResult, policy: DecisionRoutingPolicy): RoutedDecision {
  const uncertain = (reason: string): RoutedDecision => ({ outcome: 'uncertain', route: { ...policy.onUncertain, reason } });
  const pass = (reason: string): RoutedDecision => ({ outcome: 'pass', route: { ...policy.onPass, reason } });
  const fail = (reason: string): RoutedDecision => ({ outcome: 'fail', route: { ...policy.onFail, reason } });

  if (result.questionType === 'boolean') {
    if (policy.field === 'probability') {
      const p = result.probability;
      if (p === null || !Number.isFinite(p)) return uncertain('The engine did not report a probability; confidence is not substituted.');
      if (policy.passAtOrAbove !== undefined && p >= policy.passAtOrAbove)
        return pass(`probability ${fmt(p)} ≥ ${fmt(policy.passAtOrAbove)}`);
      if (policy.failAtOrBelow !== undefined && p <= policy.failAtOrBelow)
        return fail(`probability ${fmt(p)} ≤ ${fmt(policy.failAtOrBelow)}`);
      return uncertain(`probability ${fmt(p)} is between the configured thresholds`);
    }
    if (policy.field === 'confidence') {
      const c = result.confidence;
      if (c === null || !Number.isFinite(c)) return uncertain('The engine did not report a confidence; probability is not substituted.');
      if (typeof result.answer !== 'boolean') return uncertain('The engine did not return a boolean answer.');
      const minimum = policy.minConfidence ?? policy.passAtOrAbove;
      if (minimum === undefined || c < minimum) return uncertain(`confidence ${fmt(c)} is below the configured minimum`);
      return result.answer ? pass(`answer true with confidence ${fmt(c)}`) : fail(`answer false with confidence ${fmt(c)}`);
    }
    return uncertain('Score routing does not apply to a boolean proposition.');
  }

  if (result.questionType === 'choice') {
    if (typeof result.answer !== 'string' || !result.answer) return uncertain('The engine did not select an option.');
    if (policy.field === 'confidence') {
      const c = result.confidence;
      if (c === null || !Number.isFinite(c)) return uncertain('The engine did not report a confidence; the winning probability is not substituted.');
      if (policy.minConfidence !== undefined && c < policy.minConfidence)
        return uncertain(`confidence ${fmt(c)} < ${fmt(policy.minConfidence)} for “${result.answer}”`);
    } else if (policy.field === 'probability') {
      const p = result.distribution?.[result.answer];
      if (p === undefined || !Number.isFinite(p)) return uncertain('The engine did not report a probability for the selected option.');
      const minimum = policy.passAtOrAbove ?? policy.minConfidence;
      if (minimum !== undefined && p < minimum) return uncertain(`probability ${fmt(p)} < ${fmt(minimum)} for “${result.answer}”`);
    } else return uncertain('Score routing does not apply to a choice question.');
    const route = policy.choiceRoutes?.[result.answer];
    if (!route) return uncertain(`No route is configured for option “${result.answer}”.`);
    return { outcome: 'choice', route: { ...route, reason: `selected “${result.answer}”` } };
  }

  // score
  const score = result.score;
  if (score === null || !Number.isFinite(score)) return uncertain('The engine did not report a score.');
  if (policy.minConfidence !== undefined) {
    const c = result.confidence;
    if (c === null || !Number.isFinite(c)) return uncertain('The engine did not report a confidence for the score.');
    if (c < policy.minConfidence) return uncertain(`score confidence ${fmt(c)} < ${fmt(policy.minConfidence)}`);
  }
  if (policy.passAtOrAbove !== undefined && score >= policy.passAtOrAbove) return pass(`score ${fmt(score)} ≥ ${fmt(policy.passAtOrAbove)}`);
  if (policy.failAtOrBelow !== undefined && score <= policy.failAtOrBelow) return fail(`score ${fmt(score)} ≤ ${fmt(policy.failAtOrBelow)}`);
  return uncertain(`score ${fmt(score)} is between the configured thresholds`);
}

function routeTargets(route: DecisionRouteAction | undefined): string[] {
  return route?.action === 'skip-stages' ? (route.skipStageIds ?? []) : [];
}

export function allRouteActions(policy: DecisionRoutingPolicy): DecisionRouteAction[] {
  return [policy.onPass, policy.onFail, policy.onUncertain, ...Object.values(policy.choiceRoutes ?? {})];
}

/** Validates a Decision Gate configuration. `laterStageIds` are the stages after this gate. */
export function validateDecisionGate(config: DecisionGateConfig | undefined, label: string, laterStageIds: string[]): string[] {
  const errors: string[] = [];
  if (!config) return [`Decision Gate “${label}” needs a decision configuration.`];
  const prefix = `Decision Gate “${label}”`;
  if (!config.question?.trim()) errors.push(`${prefix} needs a question.`);
  if (!config.inputs?.length && config.engine !== 'deterministic-rules') errors.push(`${prefix} needs at least one input category.`);
  if (config.engine === 'deterministic-rules') {
    if (config.questionType !== 'boolean') errors.push(`${prefix}: Deterministic Rules supports boolean propositions only.`);
    if (!config.rule) errors.push(`${prefix}: Deterministic Rules needs a structured rule.`);
  }
  if (config.engine === 'subscription-llm-judge' && !(config.judge?.backendId && config.judge.providerId && config.judge.modelId))
    errors.push(`${prefix}: the Subscription LLM Judge needs an explicit backend, provider, and model.`);
  if ((config.engine === 'jev-openrouter' || config.engine === 'openrouter-judge') && !config.modelId?.trim())
    errors.push(`${prefix}: choose an exact OpenRouter model.`);
  if ((config.engine === 'jev-openrouter' || config.engine === 'openrouter-judge') && !config.connectionProfileId)
    errors.push(`${prefix}: select an OpenRouter connection explicitly.`);
  if (config.questionType === 'choice') {
    const options = config.criteria && !Array.isArray(config.criteria) ? Object.keys(config.criteria) : [];
    if (options.length < 2 || options.length > 255) errors.push(`${prefix}: a choice question needs 2–255 options.`);
  }
  if (config.questionType === 'score') {
    const levels = Array.isArray(config.criteria) ? config.criteria : [];
    if (levels.length < 2 || levels.length > 10) errors.push(`${prefix}: a score question needs 2–10 ordered levels.`);
  }
  const routing = config.routing;
  if (!routing) return [...errors, `${prefix} needs a routing policy.`];
  const unit = (value: number | undefined) => value === undefined || (value >= 0 && value <= 1);
  if (config.questionType === 'boolean') {
    if (routing.field === 'score') errors.push(`${prefix}: boolean propositions route on probability or confidence.`);
    if (routing.field === 'probability') {
      if (routing.passAtOrAbove === undefined || routing.failAtOrBelow === undefined)
        errors.push(`${prefix}: set both PASS and FAIL probability thresholds; values between them are UNCERTAIN.`);
      else if (routing.failAtOrBelow >= routing.passAtOrAbove) errors.push(`${prefix}: the FAIL threshold must be below the PASS threshold.`);
    }
    if (routing.field === 'confidence' && routing.minConfidence === undefined)
      errors.push(`${prefix}: set a minimum confidence for confidence routing.`);
    if (![routing.passAtOrAbove, routing.failAtOrBelow, routing.minConfidence].every(unit))
      errors.push(`${prefix}: probability and confidence thresholds must be between 0 and 1.`);
  }
  if (config.questionType === 'choice') {
    if (routing.field === 'score') errors.push(`${prefix}: choice questions route on confidence or the selected option's probability.`);
    const options = config.criteria && !Array.isArray(config.criteria) ? Object.keys(config.criteria) : [];
    for (const option of Object.keys(routing.choiceRoutes ?? {}))
      if (!options.includes(option)) errors.push(`${prefix}: route for unknown option “${option}”.`);
    if (![routing.passAtOrAbove, routing.minConfidence].every(unit)) errors.push(`${prefix}: thresholds must be between 0 and 1.`);
  }
  if (config.questionType === 'score') {
    if (routing.field !== 'score') errors.push(`${prefix}: score questions route on the score field.`);
    const maxLevel = (Array.isArray(config.criteria) ? config.criteria.length : 2) - 1;
    for (const value of [routing.passAtOrAbove, routing.failAtOrBelow])
      if (value !== undefined && (value < 0 || value > maxLevel)) errors.push(`${prefix}: score thresholds must be between 0 and ${maxLevel}.`);
    if (routing.passAtOrAbove !== undefined && routing.failAtOrBelow !== undefined && routing.failAtOrBelow >= routing.passAtOrAbove)
      errors.push(`${prefix}: the FAIL score threshold must be below the PASS threshold.`);
    if (!unit(routing.minConfidence)) errors.push(`${prefix}: minimum confidence must be between 0 and 1.`);
  }
  for (const action of allRouteActions(routing)) {
    for (const target of routeTargets(action))
      if (!laterStageIds.includes(target)) errors.push(`${prefix} can only skip later stages; “${target}” is not later in the workflow.`);
    if (action.action === 'escalate' && !config.escalation) errors.push(`${prefix}: an escalate route needs an escalation engine.`);
  }
  if (config.escalation) {
    if (config.escalation.engine === config.engine && (config.escalation.modelId ?? '') === (config.modelId ?? ''))
      errors.push(`${prefix}: escalation must use a different engine or model.`);
    if (config.escalation.engine === 'subscription-llm-judge' && !(config.escalation.judge?.backendId && config.escalation.judge.providerId && config.escalation.judge.modelId))
      errors.push(`${prefix}: the escalation judge needs an explicit backend, provider, and model.`);
    if ((config.escalation.engine === 'jev-openrouter' || config.escalation.engine === 'openrouter-judge') && !config.escalation.modelId?.trim())
      errors.push(`${prefix}: choose an exact OpenRouter model for escalation.`);
    if ((config.escalation.engine === 'jev-openrouter' || config.escalation.engine === 'openrouter-judge') && !config.escalation.connectionProfileId)
      errors.push(`${prefix}: select an OpenRouter connection for escalation.`);
  }
  return errors;
}

export function decisionInputLabel(category: string): string {
  return (
    (
      {
        task: 'Task specification',
        plan: 'Plan artifact',
        implementation: 'Implementation artifact',
        diff: 'Diff summary',
        tests: 'Test result',
        build: 'Build result',
        findings: 'Review findings',
        finalGate: 'Final gate result',
      } as Record<string, string>
    )[category] ?? category
  );
}
