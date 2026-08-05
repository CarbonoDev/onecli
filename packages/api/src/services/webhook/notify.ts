/**
 * In-process wake-up for parked long-pollers.
 *
 * This is a LATENCY optimization and nothing more. The queue's poll loop is the
 * correctness floor: a delivery ingested on one replica cannot wake a poller
 * parked on another, so the loop must keep re-checking regardless of whether a
 * notification ever arrives. Deleting this file would cost ~1s of wake-up
 * latency and change no outcome — that is the property to preserve if this is
 * ever swapped for LISTEN/NOTIFY or Redis pub/sub.
 */

type Waiter = () => void;

const waiters = new Map<string, Set<Waiter>>();

/** Subscribe a parked poller. Returns the unsubscribe — call it in a `finally`. */
export const subscribePending = (
  agentId: string,
  waiter: Waiter,
): (() => void) => {
  const existing = waiters.get(agentId) ?? new Set<Waiter>();
  existing.add(waiter);
  waiters.set(agentId, existing);

  return () => {
    const current = waiters.get(agentId);
    if (!current) return;
    current.delete(waiter);
    // Drop the empty set: the map is keyed by agent id and would otherwise
    // grow one entry per agent that ever polled.
    if (current.size === 0) waiters.delete(agentId);
  };
};

/** Called fire-and-forget from the ingest path. Must never throw. */
export const notifyPending = (agentId: string): void => {
  const current = waiters.get(agentId);
  if (!current) return;
  for (const waiter of [...current]) {
    try {
      waiter();
    } catch {
      // A waiter is a resolve callback; there is nothing useful to do with a
      // throw here and it must not stop the others from being woken.
    }
  }
};

/** Test seam. */
export const pendingWaiterCount = (agentId: string): number =>
  waiters.get(agentId)?.size ?? 0;
