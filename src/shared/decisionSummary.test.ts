import { describe, expect, it } from 'vitest';
import { routingSummary, routeActionText } from './decisionSummary';
import type { DecisionGateConfig } from './types';

const boolean: DecisionGateConfig = {
  engine: 'jev-openrouter',
  questionType: 'boolean',
  question: 'q',
  inputs: ['tests'],
  routing: {
    field: 'probability',
    passAtOrAbove: 0.95,
    failAtOrBelow: 0.15,
    onPass: { action: 'continue' },
    onFail: { action: 'fail-run' },
    onUncertain: { action: 'human-approval' },
  },
};

describe('routing summary', () => {
  it('states PASS, FAIL and UNCERTAIN for a probability-routed yes/no question', () => {
    expect(routingSummary(boolean)).toEqual([
      { outcome: 'PASS', when: 'Probability is 0.95 or higher', then: 'Continue to the next stage' },
      { outcome: 'FAIL', when: 'Probability is 0.15 or lower', then: 'Stop the run (FAIL)' },
      {
        outcome: 'UNCERTAIN',
        when: 'Probability is between 0.15 and 0.95, or the engine reports no probability',
        then: 'Ask a person to decide',
      },
    ]);
  });

  it('keeps confidence a separate field from probability', () => {
    const rows = routingSummary({
      ...boolean,
      routing: {
        ...boolean.routing,
        field: 'confidence',
        minConfidence: 0.7,
        passAtOrAbove: undefined,
        failAtOrBelow: undefined,
      },
    });
    expect(rows[0]!.when).toBe('The answer is yes and confidence is 0.7 or higher');
    expect(rows[2]!.when).toMatch(/Confidence is below 0.7, or the engine reports no confidence/);
    expect(JSON.stringify(rows)).not.toMatch(/probability/);
  });

  it('lists each option for a choice question and makes a missing route UNCERTAIN', () => {
    const rows = routingSummary({
      questionType: 'choice',
      criteria: { COMPLETE: 'done', HUMAN: 'ask' },
      routing: {
        field: 'confidence',
        minConfidence: 0.6,
        onPass: { action: 'continue' },
        onFail: { action: 'fail-run' },
        onUncertain: { action: 'escalate' },
        choiceRoutes: { COMPLETE: { action: 'continue' } },
      },
    });
    expect(rows.map((row) => row.outcome)).toEqual(['OPTION', 'OPTION', 'UNCERTAIN']);
    expect(rows[1]).toMatchObject({ then: 'No route is set, so this is UNCERTAIN' });
    expect(rows[2]!.then).toBe('Escalate to the second engine');
  });

  it('describes score thresholds against the level range and names skipped stages', () => {
    const rows = routingSummary(
      {
        questionType: 'score',
        criteria: ['none', 'some', 'most', 'all'],
        routing: {
          field: 'score',
          passAtOrAbove: 2.5,
          failAtOrBelow: 1,
          minConfidence: 0.5,
          onPass: { action: 'skip-stages', skipStageIds: ['b'] },
          onFail: { action: 'fail-run' },
          onUncertain: { action: 'human-approval' },
        },
      },
      (id) => `Stage ${id}`,
    );
    expect(rows[0]).toMatchObject({
      when: 'Score is 2.5 or higher (of 0–3). Confidence must be 0.5 or higher.',
      then: 'Skip Stage b',
    });
  });

  it('flags a skip route with no stages chosen', () => {
    expect(routeActionText({ action: 'skip-stages' })).toMatch(/none chosen yet/);
  });
});
