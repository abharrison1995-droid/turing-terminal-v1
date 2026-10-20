import { AlertTriangle, CheckCircle2, CircleHelp, XCircle, type LucideIcon } from 'lucide-react';
import type { CheckLine, CheckState, RouteReadiness } from '../../../shared/providerServices';

export type ReadinessLineKey = 'installation' | 'authentication' | 'catalogue' | 'lastCheck';

const STATE_ICON: Record<CheckState, LucideIcon> = {
  ok: CheckCircle2,
  attention: AlertTriangle,
  unknown: CircleHelp,
  missing: XCircle,
};

const STATE_WORD: Record<CheckState, string> = {
  ok: 'OK',
  attention: 'Needs attention',
  unknown: 'Unknown',
  missing: 'Missing',
};

/**
 * Four separate checks for one route. Each carries a word as well as an icon and a colour, so no state relies on colour
 * alone, and Unknown is shown as Unknown. A detected command line never fills in the sign-in or catalogue lines.
 */
export function ReadinessLines({
  readiness,
  className = '',
  only,
}: {
  readiness: RouteReadiness;
  className?: string;
  /** Show just some of the four lines, for a step that is only about one of them. */
  only?: ReadinessLineKey[];
}) {
  const lines: Array<[ReadinessLineKey, string, CheckLine]> = [
    ['installation', 'Installation', readiness.installation],
    ['authentication', 'Authentication', readiness.authentication],
    ['catalogue', 'Model catalogue', readiness.catalogue],
    ['lastCheck', 'Last check', readiness.lastCheck],
  ];
  return (
    <dl className={`readiness-lines ${className}`.trim()}>
      {lines
        .filter(([key]) => !only || only.includes(key))
        .map(([, name, line]) => {
          const Icon = STATE_ICON[line.state];
          return (
            <div className={`readiness-line readiness-${line.state}`} key={name}>
              <dt>{name}</dt>
              <dd>
                <span className="readiness-value">
                  <Icon size={14} aria-hidden="true" />
                  <strong>{line.label}</strong>
                  <span className="readiness-word">{STATE_WORD[line.state]}</span>
                </span>
                <small>{line.detail}</small>
              </dd>
            </div>
          );
        })}
    </dl>
  );
}
