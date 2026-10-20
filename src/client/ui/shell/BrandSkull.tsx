import { MASCOT_ANIMATIONS } from '../mascot/frames.generated';
import { framePaths } from '../mascot/MascotStatus';

/*
 * Static brand mark: the first idle frame of the approved skull, with no timers or animation. It is a logo, not a status,
 * so it carries no state; the brand name beside it is the visible text and the svg is hidden from assistive technology.
 */
const PATHS = framePaths(MASCOT_ANIMATIONS.idle.frames[0]);

export function BrandSkull() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      data-brand-skull=""
      width={24}
      height={24}
      viewBox="0 0 24 24"
      shapeRendering="crispEdges"
    >
      {PATHS.map(({ role, d }) => (
        <path key={role} fill={`var(--tt-mascot-${role})`} d={d} />
      ))}
    </svg>
  );
}
