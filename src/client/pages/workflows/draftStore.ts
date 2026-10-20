import type { WorkflowDefinition } from '../../../shared/types';

/**
 * Unsaved workflow edits, kept outside React so they survive leaving the page (for example to set up a provider in
 * Settings) and coming back. Drafts live in memory for this browser tab only. Nothing here is written to disk, storage
 * or the server: the Desktop Master only ever sees a workflow when the person presses Save.
 */
interface DraftEntry {
  draft: WorkflowDefinition;
  /** The saved workflow this draft started from, used to detect edits and a newer saved version. */
  base: WorkflowDefinition;
}

const entries = new Map<string, DraftEntry>();
let selectedId = '';
const openStages = new Map<string, string | null>();
const listeners = new Set<() => void>();

/** Stable JSON: object keys are sorted so key order never makes a draft look edited. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
}

export function isDraftDirty(
  draft: WorkflowDefinition | null | undefined,
  base: WorkflowDefinition | undefined,
) {
  return Boolean(draft && base && stableJson(draft) !== stableJson(base));
}

const notify = () => listeners.forEach((listener) => listener());

export function subscribeToDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getStoredDraft(id: string): DraftEntry | undefined {
  return entries.get(id);
}

export function storeDraft(draft: WorkflowDefinition, base: WorkflowDefinition): void {
  if (!isDraftDirty(draft, base)) entries.delete(draft.id);
  else entries.set(draft.id, { draft, base });
  notify();
}

export function discardStoredDraft(id: string): void {
  entries.delete(id);
  notify();
}

export function dirtyDraftIds(): string[] {
  return [...entries.keys()];
}

export function hasUnsavedWorkflowDrafts(): boolean {
  return entries.size > 0;
}

/** True when the saved workflow changed since the draft began, so saving would overwrite someone's newer version. */
export function isDraftStale(id: string, current: WorkflowDefinition | undefined): boolean {
  const entry = entries.get(id);
  if (!entry || !current) return false;
  return entry.base.version !== current.version || entry.base.updatedAt !== current.updatedAt;
}

export function getSelectedWorkflowId(): string {
  return selectedId;
}

export function setSelectedWorkflowId(id: string): void {
  selectedId = id;
}

export function getOpenStageId(workflowId: string): string | null {
  return openStages.get(workflowId) ?? null;
}

export function setOpenStageId(workflowId: string, stageId: string | null): void {
  openStages.set(workflowId, stageId);
}

/** Test seam: forget every draft, the selection and the open editors. */
export function resetWorkflowDraftStore(): void {
  entries.clear();
  openStages.clear();
  selectedId = '';
  notify();
}
