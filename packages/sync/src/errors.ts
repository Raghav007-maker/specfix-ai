/** A job failure that retrying cannot fix: the job is failed at once, not re-queued. */
export class PermanentJobError extends Error {}
