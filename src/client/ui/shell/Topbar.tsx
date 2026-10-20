import type { RefObject } from 'react';
import { Bell, Menu, Search } from 'lucide-react';
import { NAV_PANEL_ID } from './navModel';

export interface TopbarProps {
  title: string;
  titleQuiet: boolean;
  menuOpen: boolean;
  menuButtonRef: RefObject<HTMLButtonElement | null>;
  connectionError: boolean;
  pendingApprovalCount: number;
  onToggleMenu: () => void;
  onNotifications: () => void;
  onOpenPalette: () => void;
}

export function Topbar({
  title,
  titleQuiet,
  menuOpen,
  menuButtonRef,
  connectionError,
  pendingApprovalCount,
  onToggleMenu,
  onNotifications,
  onOpenPalette,
}: TopbarProps) {
  return (
    <header className="topbar">
      <button
        ref={menuButtonRef}
        className="mobile-menu-button icon-button"
        onClick={() => onToggleMenu()}
        aria-label="Open navigation"
        aria-expanded={menuOpen}
        aria-controls={NAV_PANEL_ID}
      >
        <Menu size={19} />
      </button>
      <p className={`topbar-title ${titleQuiet ? 'topbar-title-quiet' : ''}`}>{title}</p>
      <div className="topbar-right">
        <span className={`connection-state ${connectionError ? 'connection-state-error' : ''}`}>
          <span className="presence-dot" />
          <span className="connection-state-label">
            {connectionError ? 'Desktop Master unavailable' : 'Desktop Master online'}
          </span>
        </span>
        <button
          className="icon-button palette-trigger"
          aria-label="Open command palette"
          aria-keyshortcuts="Control+K Meta+K"
          title="Command palette (Ctrl+K)"
          onClick={() => onOpenPalette()}
        >
          <Search size={17} aria-hidden="true" />
        </button>
        <button
          className="icon-button notification-button"
          aria-label={pendingApprovalCount ? `${pendingApprovalCount} pending approvals` : 'Notifications'}
          onClick={() => onNotifications()}
        >
          <Bell size={17} />
          {pendingApprovalCount > 0 && <i />}
        </button>
      </div>
    </header>
  );
}
