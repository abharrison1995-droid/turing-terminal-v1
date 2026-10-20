import { beforeEach, describe, expect, it } from 'vitest';
import {
  dirtyDraftIds,
  discardStoredDraft,
  getOpenStageId,
  getStoredDraft,
  hasUnsavedWorkflowDrafts,
  isDraftDirty,
  isDraftStale,
  resetWorkflowDraftStore,
  setOpenStageId,
  stableJson,
  storeDraft,
} from './draftStore';
import { makeStage, makeWorkflow } from './testFixtures';

beforeEach(() => resetWorkflowDraftStore());

describe('workflow draft store', () => {
  it('ignores key order when deciding whether a draft was edited', () => {
    const base = makeWorkflow();
    const reordered = JSON.parse(JSON.stringify(base), (_k, v) =>
      v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v,
    );
    expect(stableJson(reordered)).toBe(stableJson(base));
    expect(isDraftDirty(reordered, base)).toBe(false);
  });

  it('keeps an edited draft and forgets it once it matches the saved workflow again', () => {
    const base = makeWorkflow();
    const edited = { ...base, name: 'Renamed' };
    storeDraft(edited, base);
    expect(hasUnsavedWorkflowDrafts()).toBe(true);
    expect(getStoredDraft(base.id)?.draft.name).toBe('Renamed');
    storeDraft(base, base);
    expect(hasUnsavedWorkflowDrafts()).toBe(false);
  });

  it('keeps a draft per workflow so switching never loses edits', () => {
    const a = makeWorkflow({ id: 'a' });
    const b = makeWorkflow({ id: 'b' });
    storeDraft({ ...a, name: 'A2' }, a);
    storeDraft({ ...b, stages: [...b.stages, makeStage({ id: 'extra' })] }, b);
    expect(dirtyDraftIds().sort()).toEqual(['a', 'b']);
    discardStoredDraft('a');
    expect(dirtyDraftIds()).toEqual(['b']);
  });

  it('detects that the saved workflow changed underneath a draft', () => {
    const base = makeWorkflow();
    storeDraft({ ...base, name: 'Mine' }, base);
    expect(isDraftStale(base.id, base)).toBe(false);
    expect(isDraftStale(base.id, { ...base, version: base.version + 1 })).toBe(true);
    expect(isDraftStale('unknown', base)).toBe(false);
  });

  it('remembers which stage editor was open for each workflow', () => {
    setOpenStageId('a', 'stage-2');
    expect(getOpenStageId('a')).toBe('stage-2');
    expect(getOpenStageId('b')).toBeNull();
  });
});
