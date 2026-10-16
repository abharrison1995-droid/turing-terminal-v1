import {
  Activity,
  FileCode2,
  Monitor,
  Radio,
  Settings,
  Target,
  Workflow as WorkflowIcon,
  type LucideIcon,
} from 'lucide-react';
import type { Page } from '../../pages/shared/types';

export interface NavItem {
  id: Page;
  label: string;
  icon: LucideIcon;
}

/**
 * The seven Workspace destinations, in sidebar order. Ids, labels and order are fixed by UI0_SPEC section 14 (D-5);
 * the composer ('command') is not a Workspace item and is reached through "New task".
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'workflows', label: 'Workflows', icon: WorkflowIcon },
  { id: 'projects', label: 'Projects', icon: FileCode2 },
  { id: 'goals', label: 'Grand Projects', icon: Target },
  { id: 'runs', label: 'Runs & history', icon: Activity },
  { id: 'usage', label: 'Usage', icon: Radio },
  { id: 'machines', label: 'Machines', icon: Monitor },
  { id: 'settings', label: 'Settings', icon: Settings },
];

/** The id of the sidebar landmark, referenced by the hamburger's aria-controls. */
export const NAV_PANEL_ID = 'primary-navigation';

/** Topbar title. The composer is titled "New task"; every other page uses its nav label. */
export function pageTitle(page: Page): string {
  if (page === 'command') return 'New task';
  return NAV_ITEMS.find((item) => item.id === page)?.label ?? '';
}
