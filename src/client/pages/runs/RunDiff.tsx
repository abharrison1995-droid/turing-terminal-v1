import { useMemo } from 'react';
import { isHiddenRow, limitRenderedRows, parseDiff, type DiffLine } from './diffModel';

/** Rows rendered at most. A larger diff is cut here and the view says so. */
export const DIFF_LINE_LIMIT = 2000;

export interface RunDiffResult {
  diff: string;
  truncated: boolean;
  message?: string;
}

export type RunDiffState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; result: RunDiffResult }
  | { status: 'error' };

/**
 * The Changes tab: a read-only, per-file view of the working tree diff. Added and removed rows carry a visible marker and
 * sr-only text, so the difference does not rely on colour. There are no controls besides Retry.
 */
export function RunDiff({ state, onRetry }: { state: RunDiffState; onRetry: () => void }) {
  if (state.status === 'idle') return null;
  if (state.status === 'loading') return <p role="status">Loading changes…</p>;
  if (state.status === 'error')
    return (
      <div role="alert" className="run-diff-error">
        <p>The changes could not be loaded.</p>
        <button type="button" className="secondary-button" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  return <ReadyDiff result={state.result} />;
}

function ReadyDiff({ result }: { result: RunDiffResult }) {
  // The limit counts the rows the view draws, so it is applied after parsing, not during it.
  const parsed = useMemo(
    () =>
      limitRenderedRows(
        parseDiff(result.diff, { maxLines: Number.POSITIVE_INFINITY }).files,
        DIFF_LINE_LIMIT,
      ),
    [result.diff],
  );
  return (
    <div className="run-diff">
      {result.truncated && (
        <p className="run-diff-notice">Turing truncated this diff. Only the part it kept is shown.</p>
      )}
      {result.message && <p className="run-diff-notice">{result.message}</p>}
      {parsed.capped && (
        <p className="run-diff-notice">
          Showing the first {DIFF_LINE_LIMIT} lines. Larger diffs are capped at this display limit.
        </p>
      )}
      {parsed.files.length === 0 ? (
        !result.message && <p className="run-diff-empty">No tracked changes in this working tree.</p>
      ) : (
        <div className="run-diff-pane" role="region" aria-label="Changed files" tabIndex={0}>
          {parsed.files.map((file, fileIndex) => (
            <section className="run-diff-file" key={`${fileIndex}-${file.path}`}>
              <h3>{file.path || 'Unnamed file'}</h3>
              <div className="run-diff-lines">
                {file.lines.map((line, lineIndex) => (
                  <DiffRow key={lineIndex} line={line} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  if (line.kind === 'meta') {
    // The file path is already the heading, so the index and ---/+++ header lines are not repeated.
    if (isHiddenRow(line)) return null;
    return (
      <div className="run-diff-line run-diff-meta">
        <code>{line.text}</code>
      </div>
    );
  }
  if (line.kind === 'add')
    return (
      <div className="run-diff-line run-diff-add">
        <span className="sr-only">added</span>
        <span className="run-diff-marker" aria-hidden="true">
          +
        </span>
        <code>{line.text || ' '}</code>
      </div>
    );
  if (line.kind === 'remove')
    return (
      <div className="run-diff-line run-diff-remove">
        <span className="sr-only">removed</span>
        <span className="run-diff-marker" aria-hidden="true">
          -
        </span>
        <code>{line.text || ' '}</code>
      </div>
    );
  return (
    <div className="run-diff-line run-diff-context">
      <span className="run-diff-marker" aria-hidden="true" />
      <code>{line.text || ' '}</code>
    </div>
  );
}
