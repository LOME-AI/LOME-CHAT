import { z } from 'zod';
import { paymentStatusSchema, ledgerEntryTypeSchema, deductionSourceSchema } from '../../enums.js';

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
  type: ledgerEntryTypeSchema.optional(),
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
 * Usage transactions include model, character counts, and deduction source.
 * Deposit/adjustment transactions have these fields as null.
 */
export const balanceTransactionResponseSchema = z.object({
  id: z.string(),
  amount: z.string(), // Signed decimal string
  balanceAfter: z.string(),
  type: ledgerEntryTypeSchema,
  paymentId: z.string().nullable().optional(),
  // Usage transaction fields (null for deposit/adjustment)
  model: z.string().nullable().optional(),
  inputCharacters: z.number().nullable().optional(),
  outputCharacters: z.number().nullable().optional(),
  deductionSource: deductionSourceSchema.nullable().optional(),
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

export {
  type PaymentStatus,
  type StoredDeductionSource,
  type LedgerEntryType,
  paymentStatusSchema,
  ledgerEntryTypeSchema,
  deductionSourceSchema,
} from '../../enums.js';
