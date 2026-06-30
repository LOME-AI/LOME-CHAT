/**
 * Cron seam for the Worker's scheduled trigger. The pre-rewrite cron work
 * (R2 GC, deletion-event purge) was demoted with the legacy tree; the rebuilt
 * cron surface (pollers, retention deletes, read-only auditors) lands with
 * its owning slices. Until then the wrangler cron trigger stays wired and
 * fires into this deliberate no-op.
 */
export function scheduledHandler(): Promise<void> {
  return Promise.resolve();
}
