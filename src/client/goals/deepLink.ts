export interface GoalNavigationRequest {
  requested: true;
  goalId: string | null;
}

/** Parses navigation only. The Goal detail request remains the existence and read authority check. */
export function parseGoalNavigationRequest(href: string): GoalNavigationRequest | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const pages = url.searchParams.getAll('page');
  if (pages.length !== 1 || pages[0] !== 'goals') return null;
  const goalIds = url.searchParams.getAll('goalId');
  if (goalIds.length === 0 || goalIds.length > 1) return { requested: true, goalId: null };
  const goalId = goalIds[0]!;
  if (goalId.length === 0 || goalId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(goalId))
    return { requested: true, goalId: null };
  return { requested: true, goalId };
}

/** Removes only consumed Goal navigation parameters, preserving pairing and machine-switch parameters. */
export function cleanGoalNavigationUrl(href: string): string {
  const url = new URL(href);
  url.searchParams.delete('page');
  url.searchParams.delete('goalId');
  return `${url.pathname}${url.search}${url.hash}`;
}
