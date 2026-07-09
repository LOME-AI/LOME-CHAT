import { ERROR_CODES } from '@hushbox/shared';
import type { FlowRunHandle, FlowStopReason } from '@hushbox/shared';

/**
 * One run per conversation, hard-blocked — and the deadline alarm is run
 * CONTROL only: at breach it stops the stream so the executor settles any
 * billable partial. There is no janitor and no in-flight marker; an alarm
 * that fires with no active run (post-eviction debris) is a no-op by design.
 */

export type ClaimResult =
  /**
   * `sameKeyLive: true` means a run under the SAME idempotency key is already
   * live in this room: the claim passes through to the durable referee (whose
   * attach branch answers) instead of blocking — the live run keeps the
   * in-memory claim, nothing is displaced. Only a DIFFERENT key is the
   * concurrent-run block.
   */
  | { readonly ok: true; readonly sameKeyLive: boolean }
  | { readonly ok: false; readonly code: typeof ERROR_CODES.CONCURRENT_RUN };

interface ActiveRun {
  readonly runId: string;
  readonly runKey: string;
  readonly deadlineAt: number;
  handle?: FlowRunHandle;
}

export class RunControl {
  private active: ActiveRun | null = null;

  claim(runId: string, runKey: string, deadlineAt: number): ClaimResult {
    if (this.active !== null) {
      if (this.active.runKey === runKey) {
        return { ok: true, sameKeyLive: true };
      }
      return { ok: false, code: ERROR_CODES.CONCURRENT_RUN };
    }
    this.active = { runId, runKey, deadlineAt };
    return { ok: true, sameKeyLive: false };
  }

  attach(handle: FlowRunHandle): void {
    if (this.active !== null) {
      this.active.handle = handle;
    }
  }

  activeRunId(): string | null {
    return this.active?.runId ?? null;
  }

  deadlineAt(): number | null {
    return this.active?.deadlineAt ?? null;
  }

  /** Guarded by runId so a late completion never clears a newer claim. */
  release(runId: string): void {
    if (this.active?.runId === runId) {
      this.active = null;
    }
  }

  stop(reason: FlowStopReason): boolean {
    const handle = this.active?.handle;
    if (handle === undefined) {
      return false;
    }
    handle.stop(reason);
    return true;
  }

  onAlarm(): 'stopped' | 'idle' {
    return this.stop('deadline') ? 'stopped' : 'idle';
  }
}
