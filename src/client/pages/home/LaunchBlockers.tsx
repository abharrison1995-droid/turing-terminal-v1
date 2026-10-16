import { ChevronRight, CircleHelp, FileCode2 } from 'lucide-react';
import type { Page } from '../shared/types';

/**
 * The blockers that stop Home from preparing a run. The group is an h2 with its item count, and Run points at it through
 * aria-describedby. A warning is conveyed by its icon and by a word, never by colour alone.
 */
export function LaunchBlockers({
  missingCount,
  projectMissing,
  onNavigate,
}: {
  missingCount: number;
  projectMissing: boolean;
  onNavigate: (page: Page) => void;
}) {
  const count = (missingCount > 0 ? 1 : 0) + (projectMissing ? 1 : 0);
  if (count === 0) return null;
  return (
    <div
      className="launch-blockers"
      role="group"
      id="launch-blockers"
      aria-labelledby="launch-blockers-title"
    >
      <h2 id="launch-blockers-title">
        Before you can run <span className="launch-blockers-count">{count}</span>
      </h2>
      <ul>
        {missingCount > 0 && (
          <li>
            <CircleHelp size={16} aria-hidden="true" />
            <div>
              <strong>Set up the stage models first</strong>
              <p>
                {missingCount} active AI {missingCount === 1 ? 'stage needs' : 'stages need'} a backend,
                provider, and model.
              </p>
            </div>
            <span className="launch-blocker-tag">Needs setup</span>
            <button type="button" className="text-button" onClick={() => onNavigate('workflows')}>
              Configure workflow <ChevronRight size={14} />
            </button>
          </li>
        )}
        {projectMissing && (
          <li>
            <FileCode2 size={16} aria-hidden="true" />
            <div>
              <strong>No project registered</strong>
              <p>Add a local repository before creating a run.</p>
            </div>
            <span className="launch-blocker-tag">Missing</span>
            <button type="button" className="text-button" onClick={() => onNavigate('projects')}>
              Add project <ChevronRight size={14} />
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}
