import type { Page } from '@playwright/test';
import { FIXED_NOW, emptyDashboard } from './dashboard';

/** A handler receives the request URL, its method and any `:name` segments matched from a pattern key. */
type Handler = unknown | ((url: URL, method: string, params: Record<string, string>) => unknown);

/** An answer that is not JSON, such as a server-sent event stream. Returned as-is with its own content type. */
export class RawResponse {
  constructor(
    readonly contentType: string,
    readonly body: string,
  ) {}
}

const defaultRoutes: Record<string, Handler> = {
  '/api/dashboard': emptyDashboard,
  '/api/providers': { providers: [] },
  '/api/rules': { rules: [] },
};

export interface MockApi {
  /** Every `/api/*` request the page made, as `METHOD path`. */
  readonly calls: string[];
  /** Requests with no fixture. Tests assert this is empty so nothing silently depends on live data. */
  readonly unmapped: string[];
}

/**
 * Match one pattern key against a pathname. A `:name` segment matches exactly one non-empty path segment and is
 * returned in `params`; every other segment must be equal. Returns null when the pattern does not match.
 */
function matchPattern(pattern: string, pathname: string): Record<string, string> | null {
  const expected = pattern.split('/');
  const actual = pathname.split('/');
  if (expected.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < expected.length; index += 1) {
    const want = expected[index]!;
    const got = actual[index]!;
    if (want.startsWith(':')) {
      if (got === '') return null;
      params[want.slice(1)] = decodeURIComponent(got);
    } else if (want !== got) {
      return null;
    }
  }
  return params;
}

/**
 * Resolve a pathname to its fixture. An exact key always wins. Otherwise the first `:param` pattern in insertion order
 * that matches the path is used, so `/api/runs/:id` answers `/api/runs/run-1` but not `/api/runs/run-1/diff`.
 */
function resolveRoute(
  table: Record<string, Handler>,
  pathname: string,
): { handler: Handler; params: Record<string, string> } | undefined {
  if (Object.prototype.hasOwnProperty.call(table, pathname) && table[pathname] !== undefined) {
    return { handler: table[pathname], params: {} };
  }
  for (const [pattern, handler] of Object.entries(table)) {
    if (!pattern.includes(':')) continue;
    const params = matchPattern(pattern, pathname);
    if (params) return { handler, params };
  }
  return undefined;
}

/** Pin the clock and answer `/api/*` from fixtures. Unmapped requests get a 404 and are recorded. */
export async function installFixtures(page: Page, routes: Record<string, Handler> = {}): Promise<MockApi> {
  const table = { ...defaultRoutes, ...routes };
  const api: MockApi = { calls: [], unmapped: [] };
  await page.clock.install({ time: new Date(FIXED_NOW) });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;
    api.calls.push(key);
    const resolved = resolveRoute(table, url.pathname);
    if (resolved === undefined) {
      api.unmapped.push(key);
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: '{"error":"fixture_missing"}',
      });
      return;
    }
    const { handler, params } = resolved;
    const body =
      typeof handler === 'function'
        ? (handler as (u: URL, m: string, p: Record<string, string>) => unknown)(
            url,
            request.method(),
            params,
          )
        : handler;
    if (body instanceof RawResponse) {
      await route.fulfill({ status: 200, contentType: body.contentType, body: body.body });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return api;
}
