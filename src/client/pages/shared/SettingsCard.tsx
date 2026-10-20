import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/** The one localStorage map that remembers each Settings card's open state, keyed by card id. */
const STORAGE_KEY = 'tt.settings.sections.v1';

/** Reads the stored map. Anything other than a JSON object of booleans is ignored, and so is a blocked Storage. */
function readStoredSections(): Partial<Record<string, boolean>> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
    );
  } catch {
    return {};
  }
}

function writeStoredSection(id: string, open: boolean) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readStoredSections(), [id]: open }));
  } catch {
    // Storage is blocked or full: the card keeps this state for the current visit only.
  }
}

interface SettingsCardProps {
  id: string;
  head: ReactNode;
  summary: string;
  defaultOpen: boolean;
  attention?: boolean;
  /** Bumps each time something elsewhere asks for this card to be open (for example a link from Workflows). */
  openSignal?: number;
  children: ReactNode;
}

/**
 * A Settings card as a native disclosure. The summary is the control: it holds the title row and a one-line summary.
 * Children stay mounted while the card is closed, so unsaved input and running polls are not interrupted.
 */
export function SettingsCard({
  id,
  head,
  summary,
  defaultOpen,
  attention = false,
  openSignal,
  children,
}: SettingsCardProps) {
  const [open, setOpen] = useState(() => attention || (readStoredSections()[id] ?? defaultOpen));
  // Attention opens the card once when it turns on. It is not persisted, and a later user close is respected.
  const [seenAttention, setSeenAttention] = useState(attention);
  if (attention !== seenAttention) {
    setSeenAttention(attention);
    if (attention) setOpen(true);
  }
  const [seenSignal, setSeenSignal] = useState(openSignal);
  if (openSignal !== seenSignal) {
    setSeenSignal(openSignal);
    if (openSignal) setOpen(true);
  }
  // The summary's accessible name is the card title only; the one-line summary is its description. Without this the
  // long description paragraph in the title row would become part of the toggle's name.
  const uid = useId();
  const titleId = `${uid}-title`;
  const summaryId = `${uid}-summary`;
  const summaryRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const heading = summaryRef.current?.querySelector('h2');
    if (heading && !heading.id) heading.id = titleId;
  }, [titleId]);
  return (
    <details
      className="settings-card"
      open={open}
      onToggle={(event) => {
        // A change made by this component already matches its state, so only a user toggle reaches the write below.
        const next = event.currentTarget.open;
        if (next === open) return;
        setOpen(next);
        writeStoredSection(id, next);
      }}
    >
      <summary ref={summaryRef} aria-labelledby={titleId} aria-describedby={summaryId}>
        {head}
        <span className="settings-card-summary" id={summaryId}>
          {summary}
        </span>
      </summary>
      <div className="settings-card-body">{children}</div>
    </details>
  );
}
