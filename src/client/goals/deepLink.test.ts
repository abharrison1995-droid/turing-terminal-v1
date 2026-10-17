import { describe, expect, it } from 'vitest';
import { cleanGoalNavigationUrl, parseGoalNavigationRequest } from './deepLink.js';

describe('Goal notification deep links', () => {
  it('parses an exact bounded Goal navigation request and removes only its parameters', () => {
    const href = 'https://turing.test/?page=goals&goalId=goal-A&pairRequest=pair-token#cockpit';
    expect(parseGoalNavigationRequest(href)).toEqual({ requested: true, goalId: 'goal-A' });
    expect(cleanGoalNavigationUrl(href)).toBe('/?pairRequest=pair-token#cockpit');
  });

  it.each([
    'https://turing.test/?page=goals&goalId=',
    'https://turing.test/?page=goals&goalId=../other',
    `https://turing.test/?page=goals&goalId=${'x'.repeat(129)}`,
    'https://turing.test/?page=goals&goalId=goal-a&goalId=goal-b',
  ])('ignores malformed or ambiguous Goal IDs without selecting a different Goal: %s', (href) => {
    expect(parseGoalNavigationRequest(href)).toEqual({ requested: true, goalId: null });
  });

  it('does not interpret pairing-only URLs as Goal navigation', () => {
    expect(parseGoalNavigationRequest('https://turing.test/?pairRequest=pair-token')).toBeNull();
  });
});
