import { describe, expect, it } from 'vitest';

import {
  createPaymentRequestSchema,
  processPaymentRequestSchema,
  listTransactionsQuerySchema,
  getBalanceResponseSchema,
  getSpendableQuerySchema,
  getSpendableResponseSchema,
  paymentResponseSchema,
  balanceTransactionResponseSchema,
  createPaymentResponseSchema,
  processPaymentResponseSchema,
  getPaymentStatusResponseSchema,
  listTransactionsResponseSchema,
} from './billing.js';

describe('createPaymentRequestSchema', () => {
  it('accepts an 8-decimal amount at or above the $5 minimum', () => {
    const parsed = createPaymentRequestSchema.parse({ amount: '10.00000000' });
    expect(parsed.amount).toBe('10.00000000');
    expect(parsed.idempotencyKey).toBeUndefined();
  });

  it('accepts an optional uuid idempotency key', () => {
    const key = '00000000-0000-0000-0000-000000000000';
    expect(createPaymentRequestSchema.parse({ amount: '5.00000000', idempotencyKey: key })).toEqual(
      { amount: '5.00000000', idempotencyKey: key }
    );
  });

  it('rejects an amount below the $5 minimum', () => {
    expect(createPaymentRequestSchema.safeParse({ amount: '4.99999999' }).success).toBe(false);
  });

  it('rejects an amount without exactly 8 decimal places', () => {
    expect(createPaymentRequestSchema.safeParse({ amount: '10.00' }).success).toBe(false);
  });

  it('rejects a non-uuid idempotency key', () => {
    expect(
      createPaymentRequestSchema.safeParse({ amount: '10.00000000', idempotencyKey: 'nope' })
        .success
    ).toBe(false);
  });
});

describe('processPaymentRequestSchema', () => {
  it('accepts a card token and customer code', () => {
    expect(processPaymentRequestSchema.parse({ cardToken: 'tok', customerCode: 'cus' })).toEqual({
      cardToken: 'tok',
      customerCode: 'cus',
    });
  });

  it('rejects empty card token or customer code', () => {
    expect(
      processPaymentRequestSchema.safeParse({ cardToken: '', customerCode: 'cus' }).success
    ).toBe(false);
    expect(
      processPaymentRequestSchema.safeParse({ cardToken: 'tok', customerCode: '' }).success
    ).toBe(false);
  });
});

describe('listTransactionsQuerySchema', () => {
  it('defaults limit to 50 when omitted', () => {
    expect(listTransactionsQuerySchema.parse({}).limit).toBe(50);
  });

  it('coerces numeric query strings within bounds', () => {
    const parsed = listTransactionsQuerySchema.parse({
      limit: '25',
      offset: '10',
      type: 'deposit',
    });
    expect(parsed).toMatchObject({ limit: 25, offset: 10, type: 'deposit' });
  });

  it('rejects a limit above 100', () => {
    expect(listTransactionsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });

  it('rejects an unknown ledger entry type', () => {
    expect(listTransactionsQuerySchema.safeParse({ type: 'not-a-type' }).success).toBe(false);
  });
});

describe('getBalanceResponseSchema', () => {
  it('accepts NanoUSD string balances plus the daily allowance block', () => {
    const value = {
      purchased: { balanceNanoUsd: '-5' },
      free: { balanceNanoUsd: '0' },
      allowance: {
        day: '2026-07-15',
        limitNanoUsd: '1000',
        spentNanoUsd: '250',
        remainingNanoUsd: '750',
      },
    };
    expect(getBalanceResponseSchema.parse(value)).toEqual(value);
  });

  it('rejects a missing allowance block', () => {
    expect(
      getBalanceResponseSchema.safeParse({
        purchased: { balanceNanoUsd: '0' },
        free: { balanceNanoUsd: '0' },
      }).success
    ).toBe(false);
  });
});

describe('paymentResponseSchema', () => {
  it('accepts a payment with nullable card metadata', () => {
    const value = {
      id: 'pay_1',
      amount: '10.00000000',
      status: 'completed' as const,
      cardType: null,
      cardLastFour: null,
      errorMessage: null,
      createdAt: '2026-07-15T00:00:00Z',
      updatedAt: '2026-07-15T00:00:00Z',
    };
    expect(paymentResponseSchema.parse(value)).toEqual(value);
  });

  it('accepts the expired payment status', () => {
    expect(
      paymentResponseSchema.safeParse({
        id: 'pay_1',
        amount: '10.00000000',
        status: 'expired',
        createdAt: 'now',
        updatedAt: 'now',
      }).success
    ).toBe(true);
  });

  it('rejects an invalid payment status', () => {
    expect(
      paymentResponseSchema.safeParse({
        id: 'pay_1',
        amount: '10.00000000',
        status: 'bogus',
        createdAt: 'now',
        updatedAt: 'now',
      }).success
    ).toBe(false);
  });

  it('rejects the retired refunded status', () => {
    expect(
      paymentResponseSchema.safeParse({
        id: 'pay_1',
        amount: '10.00000000',
        status: 'refunded',
        createdAt: 'now',
        updatedAt: 'now',
      }).success
    ).toBe(false);
  });
});

describe('balanceTransactionResponseSchema', () => {
  it('accepts a usage charge with model and character counts', () => {
    const value = {
      id: 'txn_1',
      amount: '-0.5',
      balanceAfter: '9.5',
      type: 'charge' as const,
      paymentId: null,
      model: 'openai/gpt-5',
      inputCharacters: 100,
      outputCharacters: 200,
      createdAt: '2026-07-15T00:00:00Z',
    };
    expect(balanceTransactionResponseSchema.parse(value)).toEqual(value);
  });

  it('rejects a retired ledger kind value', () => {
    expect(
      balanceTransactionResponseSchema.safeParse({
        id: 'txn_3',
        amount: '-0.5',
        balanceAfter: '9.5',
        type: 'usage_charge',
        createdAt: '2026-07-15T00:00:00Z',
      }).success
    ).toBe(false);
  });

  it('accepts a deposit with null usage fields', () => {
    const parsed = balanceTransactionResponseSchema.parse({
      id: 'txn_2',
      amount: '10',
      balanceAfter: '10',
      type: 'deposit',
      createdAt: '2026-07-15T00:00:00Z',
    });
    expect(parsed.type).toBe('deposit');
  });
});

describe('createPaymentResponseSchema', () => {
  it('accepts a payment id and amount', () => {
    expect(createPaymentResponseSchema.parse({ paymentId: 'pay_1', amount: '10' })).toEqual({
      paymentId: 'pay_1',
      amount: '10',
    });
  });
});

describe('processPaymentResponseSchema', () => {
  it('discriminates the completed variant', () => {
    const parsed = processPaymentResponseSchema.parse({
      status: 'completed',
      newBalance: '10',
      helcimTransactionId: 'h1',
    });
    expect(parsed.status).toBe('completed');
  });

  it('discriminates the processing variant requiring a helcim id', () => {
    expect(
      processPaymentResponseSchema.parse({ status: 'processing', helcimTransactionId: 'h1' }).status
    ).toBe('processing');
    expect(processPaymentResponseSchema.safeParse({ status: 'processing' }).success).toBe(false);
  });
});

describe('getPaymentStatusResponseSchema', () => {
  it('accepts each polling status variant', () => {
    expect(
      getPaymentStatusResponseSchema.safeParse({ status: 'completed', newBalance: '10' }).success
    ).toBe(true);
    expect(
      getPaymentStatusResponseSchema.safeParse({ status: 'failed', errorMessage: 'declined' })
        .success
    ).toBe(true);
    expect(getPaymentStatusResponseSchema.safeParse({ status: 'pending' }).success).toBe(true);
    expect(getPaymentStatusResponseSchema.safeParse({ status: 'awaiting_webhook' }).success).toBe(
      true
    );
  });

  it('rejects an unknown polling status', () => {
    expect(getPaymentStatusResponseSchema.safeParse({ status: 'exploded' }).success).toBe(false);
  });
});

describe('listTransactionsResponseSchema', () => {
  it('accepts a transaction list with a nullable cursor', () => {
    const parsed = listTransactionsResponseSchema.parse({ transactions: [], nextCursor: null });
    expect(parsed.transactions).toEqual([]);
  });
});

describe('getSpendableResponseSchema', () => {
  it('accepts NanoUSD strings, negative spendable included', () => {
    const parsed = getSpendableResponseSchema.parse({
      spendableNanoUsd: '-100000000',
      heldNanoUsd: '250000000',
      tier: 'paid',
      payer: 'self',
    });
    expect(parsed).toEqual({
      spendableNanoUsd: '-100000000',
      heldNanoUsd: '250000000',
      tier: 'paid',
      payer: 'self',
    });
  });

  it('carries the two money fields plus the payer identity that priced them', () => {
    expect(
      Object.keys(getSpendableResponseSchema.shape).toSorted((a, b) => a.localeCompare(b))
    ).toEqual(['heldNanoUsd', 'payer', 'spendableNanoUsd', 'tier']);
  });

  it('accepts the owner payer an owner-funded group turn serves', () => {
    const parsed = getSpendableResponseSchema.parse({
      spendableNanoUsd: '1000',
      heldNanoUsd: '0',
      tier: 'paid',
      payer: 'owner',
    });
    expect(parsed.payer).toBe('owner');
  });

  it('rejects a payer outside self/owner', () => {
    expect(
      getSpendableResponseSchema.safeParse({
        spendableNanoUsd: '1000',
        heldNanoUsd: '0',
        tier: 'paid',
        payer: 'sender',
      }).success
    ).toBe(false);
  });

  it('rejects a tier outside the shared tier vocabulary', () => {
    expect(
      getSpendableResponseSchema.safeParse({
        spendableNanoUsd: '1000',
        heldNanoUsd: '0',
        tier: 'premium',
        payer: 'self',
      }).success
    ).toBe(false);
  });

  it('rejects a missing field', () => {
    expect(getSpendableResponseSchema.safeParse({ spendableNanoUsd: '0' }).success).toBe(false);
  });
});

describe('getSpendableQuerySchema', () => {
  it('accepts a conversation id — the context that names the payer', () => {
    const parsed = getSpendableQuerySchema.parse({
      conversationId: '018f6c1e-0000-7000-8000-000000000000',
    });
    expect(parsed.conversationId).toBe('018f6c1e-0000-7000-8000-000000000000');
  });

  it('accepts an absent conversation id — a solo composer serves its own numbers', () => {
    expect(getSpendableQuerySchema.parse({})).toEqual({});
  });

  it('rejects a conversation id that is not a uuid', () => {
    expect(getSpendableQuerySchema.safeParse({ conversationId: 'not-a-uuid' }).success).toBe(false);
  });
});
