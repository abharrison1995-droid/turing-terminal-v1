import type { DashboardSnapshot } from '../../src/shared/types';

/** The instant every test pins the browser clock to. */
export const FIXED_NOW = '2026-01-15T12:00:00.000Z';

/**
 * A neutral, deliberately empty fixture. It contains no sample project, run, provider or usage figure, so a screenshot
 * can never be mistaken for product data. Richer fixtures are added per screen, labelled as fixtures, in later stages.
 */
export const emptyDashboard: DashboardSnapshot = {
  machine: {
    id: 'fixture-machine',
    name: 'Fixture machine',
    hostname: 'fixture-host',
    os: 'linux',
    status: 'online',
    lastSeenAt: FIXED_NOW,
  },
  projects: [],
  workflows: [],
  providers: [],
  runs: [],
  approvals: [],
  usage: {
    events: 0,
    localMinutesToday: 0,
    inputTokens: null,
    outputTokens: null,
    provenance: 'locally observed',
  },
};
