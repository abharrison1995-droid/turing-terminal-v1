import { populatedRoutes, homeRunRoutes } from './populated';
import { goalCockpitRoutes } from './goals';
import { settingsRoutes } from './settings';

/**
 * The UI.5 route table (UI5_SCOPE section 6). It layers the UI.2, UI.3 and UI.4 fixture sets, unchanged, over the shared
 * populated base, so one capture can reach Home, Runs, Grand Projects, Usage, Machines and Settings.
 *
 * Each of those tables spreads `populatedRoutes`, so its copy of the base answers the same keys with the same objects.
 * Only the entries that are not the base's own object are kept, so a later spread cannot bring the base's usage, pairing
 * or goal answers back over the phase's own. The Home dashboard is the UI.2 snapshot, because that is where the blockers
 * and the runs live.
 */

/** The entries of a table whose value is not the shared base's object for the same key. */
function specificRoutes(table: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(table).filter(([key, value]) => populatedRoutes[key] !== value));
}

export const mobileRoutes: Record<string, unknown> = {
  ...populatedRoutes,
  ...specificRoutes(settingsRoutes),
  ...specificRoutes(goalCockpitRoutes),
  ...specificRoutes(homeRunRoutes),
  // The phone's Stop run control posts here. It only needs an acknowledgement; the fixture run keeps its status.
  '/api/runs/:id/cancel': { accepted: true },
};
