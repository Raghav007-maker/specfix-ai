/**
 * Whether a ticket version counts as signed off. A "marked ready" event only counts when an
 * analysis of that same version finished before it: a ticket marked ready before the model ran
 * (possible before the sign-off gate existed) has flags that were never weighed, so it is not
 * ready. Events backfilled from history predate the tool and are taken as they are.
 */
export interface ReadinessEventLike {
  event: string;
  ticket_version_id: string | null;
  occurred_at: Date | string;
  backfilled?: boolean;
}

const at = (e: ReadinessEventLike) => new Date(e.occurred_at).getTime();

export function isSignedOff(events: readonly ReadinessEventLike[], versionId: string): boolean {
  const mine = events.filter((e) => e.ticket_version_id === versionId);
  return mine.some(
    (ready) =>
      ready.event === 'marked_ready' &&
      (ready.backfilled === true ||
        mine.some((a) => a.event === 'analysis_complete' && at(a) <= at(ready)))
  );
}
