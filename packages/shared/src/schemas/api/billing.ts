import { z } from 'zod';

import { LEDGER_ENTRY_KINDS, PAYMENT_STATUSES } from '../../billing-enums.js';
import type { UserTier } from '../../affordability/index.js';

/**
 * Payment lifecycle statuses on the wire. Derives from the single shared
 * `PAYMENT_STATUSES` const, which also feeds the `payment_status` pgEnum
 * (`packages/db`) — the Pattern-D pre-claim lifecycle. Shared cannot import the
 * pgEnum (db depends on shared), so the const is the single source both sides
 * derive from.
 */
export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);

/** TypeScript type for payment status */
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

/**
 * Ledger-entry kinds on the wire. Derives from the single shared
 * `LEDGER_ENTRY_KINDS` const, which also feeds the `ledger_entry_kind` pgEnum
 * (`packages/db`) — the double-entry vocabulary. Shared cannot import the pgEnum
 * (db depends on shared), so the const is the single source both sides derive
 * from.
 */
export const ledgerEntryKindSchema = z.enum(LEDGER_ENTRY_KINDS);

/** TypeScript type for a ledger-entry kind */
export type LedgerEntryKind = z.infer<typeof ledgerEntryKindSchema>;

/**
 * Request schema for creating a payment.
 * Amount must be at least $5.00 (stored as decimal string with 8 decimal places).
 * idempotencyKey enables safe retries - same key returns existing payment.
 */
export const createPaymentRequestSchema = z.object({
  amount: z
    .string()
    .regex(/^\d+\.\d{8}$/, 'Amount must be a decimal with 8 decimal places (e.g., "10.00000000")')
    .refine((val) => Number.parseFloat(val) >= 5, 'Minimum deposit is $5.00'),
  idempotencyKey: z.uuid('Idempotency key must be a valid UUID').optional(),
});

export type CreatePaymentRequest = z.infer<typeof createPaymentRequestSchema>;

/**
 * Request schema for processing a payment with a card token.
 * customerCode is required as Helcim links card tokens to customers.
 */
export const processPaymentRequestSchema = z.object({
  cardToken: z.string().min(1, 'Card token is required'),
  customerCode: z.string().min(1, 'Customer code is required'),
});

export type ProcessPaymentRequest = z.infer<typeof processPaymentRequestSchema>;

/**
 * Query schema for listing balance transactions.
 */
export const listTransactionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().optional(),
  offset: z.coerce.number().int().min(0).optional(),
  type: ledgerEntryKindSchema.optional(),
});

export type ListTransactionsQuery = z.infer<typeof listTransactionsQuerySchema>;

/**
 * Schema for the `GET /billing/balance` response. Money crosses the wire as
 * canonical NanoUSD strings (never floats). `purchased` is the paid,
 * negative-capable wallet that funds turns and gates admission; `free` is the
 * (always non-negative) free wallet; `allowance` is the free-tier daily
 * allowance for the current UTC day. The frontend derives display and gate
 * values through the NanoUSD helpers — it never coerces these strings to floats.
 */
export const getBalanceResponseSchema = z.object({
  purchased: z.object({ balanceNanoUsd: z.string() }),
  free: z.object({ balanceNanoUsd: z.string() }),
  allowance: z.object({
    day: z.string(),
    limitNanoUsd: z.string(),
    spentNanoUsd: z.string(),
    remainingNanoUsd: z.string(),
  }),
});

export type GetBalanceResponse = z.infer<typeof getBalanceResponseSchema>;

/**
 * The tier vocabulary on the wire, keyed by the shared `UserTier` union: the
 * `satisfies Record<UserTier, UserTier>` makes the object exhaustive at
 * compile time, so a new tier in the union fails typecheck here instead of
 * silently narrowing the wire.
 */
const USER_TIER_VALUES = {
  trial: 'trial',
  guest: 'guest',
  free: 'free',
  paid: 'paid',
} as const satisfies Record<UserTier, UserTier>;

/** Tier on the wire. Derived from the shared union, never a parallel list. */
export const userTierSchema = z.enum(USER_TIER_VALUES);

/**
 * Query for `GET /billing/spendable`. The conversation is the context that
 * NAMES THE PAYER (BILLING §Group Funding 1): an owner-funded turn is priced
 * from the owner's funds at the owner's tier, so the composer must ask for the
 * numbers of the wallet that will actually pay. Absent for a solo composer,
 * whose payer is always the caller.
 */
export const getSpendableQuerySchema = z.object({
  conversationId: z.uuid().optional(),
});

export type GetSpendableQuery = z.infer<typeof getSpendableQuerySchema>;

/**
 * Schema for the `GET /billing/spendable` response — the payer's funding
 * snapshot (BILLING §Affordability 1, §Data Structures `FundingSnapshot`).
 * `spendableNanoUsd` is hold-aware and complete for every tier — the number
 * admission would gate with when the payer is the caller, which is the
 * purchased wallet's spendable funds at the paid tier and the day's remaining
 * free allowance below it, so no surface has to compose a funding figure from a
 * second endpoint (it may be negative once holds exceed the funds behind it);
 * `heldNanoUsd` is what active holds subtracted, so `spendable + held`
 * reconstructs the hold-blind effective balance the picker greys on. `tier` and
 * `payer` identify WHOSE money those figures are: an owner-funded group turn
 * serves the owner's hold-aware group remaining at the owner's tier, not the
 * sender's — with the owner-balance dimension priced RAW (no cushion, no owner
 * wallet holds) so a member cannot infer the owner's activity, which is why an
 * owner-funded figure may diverge from what admission admits and admission then
 * refuses outright (BILLING §Group Funding 6b). Money
 * crosses the wire as canonical NanoUSD strings, never floats. The per-wallet
 * concurrent-run cap is deliberately NOT served — it is enforced solely at
 * admission with its typed refusal.
 */
export const getSpendableResponseSchema = z.object({
  spendableNanoUsd: z.string(),
  heldNanoUsd: z.string(),
  tier: userTierSchema,
  payer: z.enum(['self', 'owner']),
});

export type GetSpendableResponse = z.infer<typeof getSpendableResponseSchema>;

/**
 * Schema for a payment entity in API responses.
 */
export const paymentResponseSchema = z.object({
  id: z.string(),
  amount: z.string(),
  status: paymentStatusSchema,
  cardType: z.string().nullable().optional(),
  cardLastFour: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type PaymentResponse = z.infer<typeof paymentResponseSchema>;

/**
 * Schema for a balance transaction entity in API responses.
 * Usage (`charge`) transactions include model and character counts.
 * Deposit/clawback transactions have these fields as null.
 */
export const balanceTransactionResponseSchema = z.object({
  id: z.string(),
  amount: z.string(), // Signed decimal string
  balanceAfter: z.string(),
  type: ledgerEntryKindSchema,
  paymentId: z.string().nullable().optional(),
  // Usage transaction fields (null for deposit/clawback)
  model: z.string().nullable().optional(),
  inputCharacters: z.number().nullable().optional(),
  outputCharacters: z.number().nullable().optional(),
  createdAt: z.string(),
});

export type BalanceTransactionResponse = z.infer<typeof balanceTransactionResponseSchema>;

/**
 * Response schema for POST /billing/payments.
 */
export const createPaymentResponseSchema = z.object({
  paymentId: z.string(),
  amount: z.string(),
});

export type CreatePaymentResponse = z.infer<typeof createPaymentResponseSchema>;

/**
 * Response schema for POST /billing/payments/:id/process when payment is approved.
 */
export const processPaymentResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('completed'),
    newBalance: z.string(),
    helcimTransactionId: z.string().optional(),
  }),
  z.object({
    status: z.literal('processing'),
    helcimTransactionId: z.string(),
  }),
]);

export type ProcessPaymentResponse = z.infer<typeof processPaymentResponseSchema>;

/**
 * Response schema for GET /billing/payments/:id (polling).
 */
export const getPaymentStatusResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('completed'),
    newBalance: z.string(),
  }),
  z.object({
    status: z.literal('failed'),
    errorMessage: z.string().nullable().optional(),
  }),
  z.object({
    status: z.literal('pending'),
  }),
  z.object({
    status: z.literal('awaiting_webhook'),
  }),
]);

export type GetPaymentStatusResponse = z.infer<typeof getPaymentStatusResponseSchema>;

/**
 * Response schema for GET /billing/transactions.
 */
export const listTransactionsResponseSchema = z.object({
  transactions: z.array(balanceTransactionResponseSchema),
  nextCursor: z.string().nullable().optional(),
});

export type ListTransactionsResponse = z.infer<typeof listTransactionsResponseSchema>;
