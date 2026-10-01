import { invoke, isTauri } from '@tauri-apps/api/core';

export interface DesktopToolStatus {
  id: string;
  name: string;
  installed: boolean;
}

export interface DesktopRuntime {
  status: string;
  version: string;
  port: number | null;
  masterUrl: string | null;
  uptimeSeconds: number | null;
  startedByApp: boolean;
  error: string | null;
  logPath: string;
  dataPath: string;
  keepMasterOnClose: boolean;
  startAtLogin: boolean;
  tools: DesktopToolStatus[];
}

let apiBase = '';

export function isDesktopShell(): boolean {
  return isTauri();
}

export function masterApiUrl(path: string): string {
  return `${apiBase}${path}`;
}

export function setMasterApiBase(url: string | null): void {
  apiBase = url ?? '';
}

export const desktop = {
  runtime: () => invoke<DesktopRuntime>('desktop_runtime'),
  setKeepMasterOnClose: (keep: boolean) => invoke<void>('set_keep_master_on_close', { keep }),
  setStartAtLogin: (enabled: boolean) => invoke<void>('set_start_at_login', { enabled }),
  restartMaster: () => invoke<DesktopRuntime>('restart_master'),
  openLogFolder: () => invoke<void>('open_log_folder'),
  quit: () => invoke<void>('quit_desktop'),
};
