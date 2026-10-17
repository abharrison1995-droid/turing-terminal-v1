import { useEffect, useMemo, useState } from 'react';
import { MASCOT_ANIMATIONS } from './frames.generated';
import { useMascotFrame } from './playback';

/*
 * Decorative status mark. The svg is aria-hidden, so the adjacent label carries the real status text and the mark is
 * never the only carrier of meaning. Fills use the --tt-mascot-* tokens only, one merged path per colour.
 */

export type MascotAnimationName = keyof typeof MASCOT_ANIMATIONS;
export type MascotSize = 24 | 48 | 96;

type MascotRole = 'outline' | 'body' | 'shade' | 'accent';

const ROLE_OF_CHAR: Record<string, MascotRole> = { o: 'outline', b: 'body', s: 'shade', a: 'accent' };
const ROLE_ORDER: readonly MascotRole[] = ['outline', 'body', 'shade', 'accent'];
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export interface MascotStatusProps {
  animation: MascotAnimationName;
  size: MascotSize;
  /** Visible status text. Required and non-blank, because the mark is hidden from assistive technology. */
  label: string;
}

/** One merged rectangle path per colour for a frame. Each run of identical cells in a row becomes one 1-high rect. */
function framePaths(rows: readonly string[]): Array<{ role: MascotRole; d: string }> {
  const data: Record<MascotRole, string> = { outline: '', body: '', shade: '', accent: '' };
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const char = row[x]!;
      if (char === '.') {
        x += 1;
        continue;
      }
      const role = ROLE_OF_CHAR[char];
      if (!role) throw new Error(`mascot frame contains an unknown cell '${char}'`);
      let end = x + 1;
      while (end < row.length && row[end] === char) end += 1;
      const width = end - x;
      data[role] += `M${x} ${y}h${width}v1h-${width}z`;
      x = end;
    }
  });
  return ROLE_ORDER.filter((role) => data[role] !== '').map((role) => ({ role, d: data[role] }));
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

export function MascotStatus({ animation, size, label }: MascotStatusProps) {
  const reducedMotion = usePrefersReducedMotion();
  const frameIndex = useMascotFrame(MASCOT_ANIMATIONS[animation], { reducedMotion });
  const paths = useMemo(
    () => framePaths(MASCOT_ANIMATIONS[animation].frames[frameIndex]),
    [animation, frameIndex],
  );
  if (label.trim() === '') throw new Error('MascotStatus needs a non-blank label');
  return (
    <span className="mascot-status">
      <svg
        aria-hidden="true"
        focusable="false"
        data-mascot=""
        data-size={size}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        shapeRendering="crispEdges"
      >
        {paths.map(({ role, d }) => (
          <path key={role} fill={`var(--tt-mascot-${role})`} d={d} />
        ))}
      </svg>
      <span className="mascot-status-label">{label}</span>
    </span>
  );
}
