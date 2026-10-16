import type { PermissionMode, WorkflowDefinition } from '../../../shared/types';
import { billingModeLabel } from '../../../shared/billing';
import { capitalize } from '../shared/runStatus';

/**
 * The selected workflow's safeguards, read only. Run options can change them for one run, and this strip says so. It
 * holds no controls, so it cannot change a setting.
 */
export function Safeguards({
  billingMode,
  lockProviders,
  permissionMode,
}: {
  billingMode: WorkflowDefinition['billingMode'];
  lockProviders: boolean;
  permissionMode: PermissionMode;
}) {
  return (
    <section className="safeguards" aria-label="Safeguards">
      <span>
        <small>Billing</small> <strong>{billingModeLabel(billingMode)}</strong>
      </span>
      <span>
        <small>Provider lock</small> <strong>{lockProviders ? 'On' : 'Off'}</strong>
      </span>
      <span>
        <small>Permissions</small> <strong>{capitalize(permissionMode)}</strong>
      </span>
      <p>Workflow defaults. Run options can change them for one run. Edit them in Workflow Studio.</p>
    </section>
  );
}
