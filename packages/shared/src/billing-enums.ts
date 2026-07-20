/**
 * The two closed billing wire/database vocabularies, in their canonical order.
 * Each is the single source feeding both the `packages/db` pgEnum and the
 * `packages/shared` wire Zod schema — changing a value is an enum migration plus
 * a client contract change, never ad-hoc data. Order is byte-identical to the
 * deployed pgEnums; drift is caught by `packages/db/src/schema/shape-enums.test.ts`.
 */

/**
 * `ledger_entries.kind` discriminator (double-entry vocabulary). OpenRouter
 * returns the authoritative cost inline, so settlement charges it directly with
 * no async reconcile leg; rare manual cost corrections use charge/refund.
 */
export const LEDGER_ENTRY_KINDS = ['deposit', 'charge', 'clawback', 'promo', 'refund'] as const;

/**
 * `payments.status` Pattern-D pre-claim lifecycle: pending → awaiting_webhook →
 * completed/failed, with expired for pre-claims the verify job gives up on.
 * `expired` replaces the retired `refunded` (admin card refunds do not exist;
 * see the Reversibility Iron Law).
 */
export const PAYMENT_STATUSES = [
  'pending',
  'awaiting_webhook',
  'completed',
  'failed',
  'expired',
] as const;
