/**
 * The closed set of handler outcomes. `yield` re-pends the job with an
 * updated payload and neutralizes its claim increment (checkpoints never
 * consume retries); `dead` is the handler's verdict for deterministic
 * failures (payload parse, 4xx-class) that retrying cannot fix.
 *
 * `fail`/`dead` error strings are operator diagnostics: codes and summaries
 * only, never message content or other user data — they land verbatim in the
 * job row's error history (truncated at the storage cap in `complete.ts`).
 *
 * `completed` is constructed only by `JobExecution.completeWithinTx`: it
 * marks that the handler already wrote the fenced terminal transition inside
 * its own transaction, so the executor must not write one. There is
 * deliberately no public builder — fabricating it leaves the row running
 * until its lease expires.
 */
export type JobOutcome =
  | { readonly kind: 'ok'; readonly result: unknown }
  | { readonly kind: 'fail'; readonly error: string }
  | { readonly kind: 'yield'; readonly checkpoint: unknown }
  | { readonly kind: 'dead'; readonly error: string }
  | { readonly kind: 'completed'; readonly completion: 'succeeded' | 'cancelled' };

export const jobOutcome = {
  ok(result?: unknown): JobOutcome {
    return { kind: 'ok', result: result === undefined ? null : result };
  },
  fail(error: string): JobOutcome {
    return { kind: 'fail', error };
  },
  yield(checkpoint: unknown): JobOutcome {
    return { kind: 'yield', checkpoint };
  },
  dead(error: string): JobOutcome {
    return { kind: 'dead', error };
  },
} as const;
