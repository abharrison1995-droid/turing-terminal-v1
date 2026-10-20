import type { DecisionGateConfig, DecisionRouteAction } from './types.js';

/**
 * Plain-language description of how a Decision Gate routes. It states the same rules `routeDecision` applies and adds
 * none. Probability, confidence and score stay separate named fields, and UNCERTAIN is always listed with its cause.
 */
export interface RoutingSummaryRow {
  outcome: 'PASS' | 'FAIL' | 'UNCERTAIN' | 'OPTION';
  /** What has to be true for this outcome. */
  when: string;
  /** What the run then does. */
  then: string;
}

const fmt = (value: number) => (Math.round(value * 1_000) / 1_000).toString();

export function routeActionText(
  action: DecisionRouteAction,
  stageLabel: (id: string) => string = (id) => id,
): string {
  switch (action.action) {
    case 'continue':
      return 'Continue to the next stage';
    case 'fail-run':
      return 'Stop the run (FAIL)';
    case 'human-approval':
      return 'Ask a person to decide';
    case 'escalate':
      return 'Escalate to the second engine';
    case 'skip-stages':
      return action.skipStageIds?.length
        ? `Skip ${action.skipStageIds.map(stageLabel).join(', ')}`
        : 'Skip later stages (none chosen yet)';
  }
}

export function routingSummary(
  config: Pick<DecisionGateConfig, 'questionType' | 'routing' | 'criteria'>,
  stageLabel: (id: string) => string = (id) => id,
): RoutingSummaryRow[] {
  const { routing, questionType } = config;
  const act = (action: DecisionRouteAction) => routeActionText(action, stageLabel);
  const rows: RoutingSummaryRow[] = [];
  const noValue = (field: string) => `the engine reports no ${field}`;

  if (questionType === 'boolean' && routing.field === 'probability') {
    const pass = routing.passAtOrAbove;
    const fail = routing.failAtOrBelow;
    rows.push({
      outcome: 'PASS',
      when: pass === undefined ? 'No PASS threshold is set' : `probability is ${fmt(pass)} or higher`,
      then: act(routing.onPass),
    });
    rows.push({
      outcome: 'FAIL',
      when: fail === undefined ? 'No FAIL threshold is set' : `probability is ${fmt(fail)} or lower`,
      then: act(routing.onFail),
    });
    rows.push({
      outcome: 'UNCERTAIN',
      when:
        pass !== undefined && fail !== undefined
          ? `probability is between ${fmt(fail)} and ${fmt(pass)}, or ${noValue('probability')}`
          : `probability is in between, or ${noValue('probability')}`,
      then: act(routing.onUncertain),
    });
  } else if (questionType === 'boolean') {
    const minimum = routing.minConfidence ?? routing.passAtOrAbove;
    rows.push({
      outcome: 'PASS',
      when:
        minimum === undefined
          ? 'The answer is yes and a minimum confidence is not set'
          : `the answer is yes and confidence is ${fmt(minimum)} or higher`,
      then: act(routing.onPass),
    });
    rows.push({
      outcome: 'FAIL',
      when:
        minimum === undefined
          ? 'The answer is no and a minimum confidence is not set'
          : `the answer is no and confidence is ${fmt(minimum)} or higher`,
      then: act(routing.onFail),
    });
    rows.push({
      outcome: 'UNCERTAIN',
      when: `confidence is below ${minimum === undefined ? 'the minimum' : fmt(minimum)}, or ${noValue('confidence')}`,
      then: act(routing.onUncertain),
    });
  } else if (questionType === 'choice') {
    const options = config.criteria && !Array.isArray(config.criteria) ? Object.keys(config.criteria) : [];
    const gate =
      routing.field === 'confidence'
        ? routing.minConfidence === undefined
          ? ''
          : ` with confidence ${fmt(routing.minConfidence)} or higher`
        : routing.passAtOrAbove === undefined
          ? ''
          : ` with probability ${fmt(routing.passAtOrAbove)} or higher`;
    for (const option of options)
      rows.push({
        outcome: 'OPTION',
        when: `the engine selects “${option}”${gate}`,
        then: routing.choiceRoutes?.[option]
          ? act(routing.choiceRoutes[option]!)
          : 'No route is set, so this is UNCERTAIN',
      });
    rows.push({
      outcome: 'UNCERTAIN',
      when: `no option is selected, the ${routing.field === 'confidence' ? 'confidence' : 'probability'} is below the minimum, or ${noValue(routing.field)}`,
      then: act(routing.onUncertain),
    });
  } else {
    const levels = Array.isArray(config.criteria) ? config.criteria : [];
    const confidence =
      routing.minConfidence === undefined
        ? ''
        : ` Confidence must be ${fmt(routing.minConfidence)} or higher.`;
    rows.push({
      outcome: 'PASS',
      when:
        routing.passAtOrAbove === undefined
          ? 'No PASS score is set'
          : `score is ${fmt(routing.passAtOrAbove)} or higher${levels.length ? ` (of 0–${levels.length - 1})` : ''}.${confidence}`.trim(),
      then: act(routing.onPass),
    });
    rows.push({
      outcome: 'FAIL',
      when:
        routing.failAtOrBelow === undefined
          ? 'No FAIL score is set'
          : `score is ${fmt(routing.failAtOrBelow)} or lower`,
      then: act(routing.onFail),
    });
    rows.push({
      outcome: 'UNCERTAIN',
      when: `score is between the thresholds, confidence is too low, or ${noValue('score')}`,
      then: act(routing.onUncertain),
    });
  }
  return rows.map((row) => ({ ...row, when: row.when.charAt(0).toUpperCase() + row.when.slice(1) }));
}
