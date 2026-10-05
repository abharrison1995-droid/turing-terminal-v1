import type { GoalMilestoneSpec } from '../../shared/goals.js';

/**
 * Milestone scope matching. Globs use the conservative alphabet the definition validator allows:
 * `*` (not across `/`), `**` (across `/`; a double star followed by a slash also matches no directory), `?`, `[...]` and `{a,b}`.
 * Paths are project-relative with `/` separators.
 */
const cache = new Map<string, RegExp>();

function expand(glob: string): string {
  let out = '';
  for (let index = 0; index < glob.length; index++) {
    const ch = glob[index]!;
    if (ch === '*') {
      if (glob[index + 1] === '*') {
        index++;
        if (glob[index + 1] === '/') {
          index++;
          out += '(?:.*/)?';
        } else out += '.*';
      } else out += '[^/]*';
    } else if (ch === '?') out += '[^/]';
    else if (ch === '{') out += '(?:';
    else if (ch === '}') out += ')';
    else if (ch === ',') out += '|';
    else if (ch === '[') {
      const close = glob.indexOf(']', index + 1);
      if (close === -1) out += '\\[';
      else {
        out += `[${glob.slice(index + 1, close).replace(/\\/g, '\\\\')}]`;
        index = close;
      }
    } else out += ch.replace(/[.+^$()|\\]/g, '\\$&');
  }
  return out;
}

export function globMatches(glob: string, path: string): boolean {
  let regex = cache.get(glob);
  if (!regex) {
    try {
      regex = new RegExp(`^${expand(glob)}$`);
    } catch {
      return false;
    }
    cache.set(glob, regex);
  }
  return regex.test(path);
}

/** True when the path matches an include glob and no exclude glob. An empty include list allows nothing. */
export function pathInMilestoneScope(path: string, scope: GoalMilestoneSpec['allowedScope']): boolean {
  if (scope.excludeGlobs.some((glob) => globMatches(glob, path))) return false;
  return scope.includeGlobs.some((glob) => globMatches(glob, path));
}

/**
 * The literal directory prefix of each include glob (`src/**` gives `src`; a glob that starts with a double star gives the empty prefix): a coarse filter that is
 * always at least as wide as the glob set. The exact check is `pathInMilestoneScope`.
 */
export function scopePrefixes(scope: GoalMilestoneSpec['allowedScope']): string[] {
  const prefixes = new Set<string>();
  for (const glob of scope.includeGlobs) {
    const segments = glob.split('/');
    const literal: string[] = [];
    for (const segment of segments.slice(0, -1)) {
      if (/[*?[\]{},]/.test(segment)) break;
      literal.push(segment);
    }
    prefixes.add(literal.join('/'));
  }
  return [...prefixes];
}
