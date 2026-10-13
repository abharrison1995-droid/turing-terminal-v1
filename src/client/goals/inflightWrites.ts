/**
 * The completion and correction writes that are still unresolved in this page. A panel that is remounted while one of its
 * writes is in flight reads this record, so it can show the write as in progress and never send it again.
 *
 * The record is module memory only. It is never written to storage, it has no timers and it makes no requests. It never
 * decides success: an entry is removed when its request settles, whatever the answer, and a lost or unknown answer is
 * handled by the panel's own unknown-outcome path. An entry is therefore a claim that a request is unresolved, not that
 * it failed or succeeded.
 */

export type InflightKind = 'record' | 'complete' | 'correction-request' | 'correction-decision';

/** The exact write a panel is about to send. Two writes share a key only when every field here is equal. */
export interface InflightWrite {
  goalId: string;
  handoffId: string | null;
  attestationId: string | null;
  kind: InflightKind;
  /** The identity the write names first: the preflight digest, the action digest, the chain position or the approval id. */
  identity: string;
  /** The rest of the request, as a canonical string, for a write whose identity alone does not name it. Null otherwise. */
  detail: string | null;
}

/** Returned by beginInflight for a write that may be sent. Settling it is the only way its entry is removed. */
export interface InflightHandle {
  readonly key: string;
  readonly scope: string;
  readonly owner: string;
  readonly write: InflightWrite;
}

/** The most unresolved writes the page holds at once. A write beyond this is refused, never evicting an entry. */
export const MAX_INFLIGHT_WRITES = 16;

type Probe = Pick<InflightWrite, 'goalId' | 'handoffId' | 'attestationId' | 'kind' | 'identity'>;

interface Subscriber {
  owner: string;
  notify: () => void;
}

const entries = new Map<string, InflightHandle>();
const subscribers = new Map<string, Set<Subscriber>>();

const scopeOf = (goalId: string, attestationId: string | null) => JSON.stringify([goalId, attestationId]);

const keyOf = (write: InflightWrite) =>
  JSON.stringify([
    write.goalId,
    write.handoffId,
    write.attestationId,
    write.kind,
    write.identity,
    write.detail,
  ]);

/**
 * Records a write as unresolved. Returns 'busy' when the same exact write is already unresolved, or when the page already
 * holds the maximum. A busy answer means the caller must not send the write.
 */
export function beginInflight(write: InflightWrite, owner: string): InflightHandle | 'busy' {
  const key = keyOf(write);
  if (entries.has(key) || entries.size >= MAX_INFLIGHT_WRITES) return 'busy';
  const handle: InflightHandle = {
    key,
    scope: scopeOf(write.goalId, write.attestationId),
    owner,
    write: { ...write },
  };
  entries.set(key, handle);
  return handle;
}

/** True when this exact write is unresolved, whichever panel began it. */
export function isInflight(write: InflightWrite): boolean {
  return entries.has(keyOf(write));
}

/**
 * True when a write that names this identity is unresolved and was begun by another panel. A panel uses it on mount and on
 * read, when the detail of a write it has not yet been asked to send is not known. Its own writes are excluded, because
 * the panel's reducer already holds them.
 */
export function isInflightAt(probe: Probe, owner: string): boolean {
  for (const handle of entries.values()) {
    const { write } = handle;
    if (
      handle.owner !== owner &&
      write.goalId === probe.goalId &&
      write.handoffId === probe.handoffId &&
      write.attestationId === probe.attestationId &&
      write.kind === probe.kind &&
      write.identity === probe.identity
    )
      return true;
  }
  return false;
}

/**
 * Removes the entry the handle began, once its request has settled. A handle whose entry is already gone, or was replaced,
 * changes nothing. Other panels for the same Goal and attestation are told, so they read the saved state again.
 */
export function settleInflight(handle: InflightHandle): void {
  if (entries.get(handle.key) !== handle) return;
  entries.delete(handle.key);
  for (const subscriber of [...(subscribers.get(handle.scope) ?? [])])
    if (subscriber.owner !== handle.owner) subscriber.notify();
}

/**
 * Asks to be told when a write for this Goal and attestation settles in another panel. The returned function unsubscribes.
 * A panel subscribes on mount and is told only what it needs to read again, so no read is repeated for its own write.
 */
export function subscribeInflight(
  goalId: string,
  attestationId: string,
  owner: string,
  notify: () => void,
): () => void {
  const scope = scopeOf(goalId, attestationId);
  const subscriber: Subscriber = { owner, notify };
  const set = subscribers.get(scope) ?? new Set<Subscriber>();
  set.add(subscriber);
  subscribers.set(scope, set);
  return () => {
    set.delete(subscriber);
    if (set.size === 0 && subscribers.get(scope) === set) subscribers.delete(scope);
  };
}

/**
 * Test support only: forgets every unresolved entry, so one case cannot hold a later case's writes. It exists only for
 * tests and must not be imported by production modules.
 */
export function clearInflightWritesForTests(): void {
  entries.clear();
}
