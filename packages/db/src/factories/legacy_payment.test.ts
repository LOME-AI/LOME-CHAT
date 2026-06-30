import { describe, it, expect } from 'vitest';

import { paymentFactory } from './legacy_payment';

describe('paymentFactory', () => {
  it('builds a complete payment object', () => {
    const payment = paymentFactory.build();

    expect(payment.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(payment.amount).toBeTruthy();
    expect(payment.status).toBe('completed');
    expect(payment.createdAt).toBeInstanceOf(Date);
    expect(payment.updatedAt).toBeInstanceOf(Date);
  });

  it('generates userId as nullable UUID by default', () => {
    const payment = paymentFactory.build();
    expect(payment.userId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('allows null userId', () => {
    const payment = paymentFactory.build({ userId: null });
    expect(payment.userId).toBeNull();
  });

  it('allows field overrides', () => {
    const payment = paymentFactory.build({ amount: '50.00000000' });
    expect(payment.amount).toBe('50.00000000');
  });

  it('allows status override', () => {
    const payment = paymentFactory.build({ status: 'pending' });
    expect(payment.status).toBe('pending');
  });

  it('generates valid status values', () => {
    const validStatuses = ['pending', 'awaiting_webhook', 'completed', 'failed', 'refunded'];
    const payment = paymentFactory.build();
    expect(validStatuses).toContain(payment.status);
  });

  it('builds completed payments with Helcim details', () => {
    const payment = paymentFactory.build({ status: 'completed' });
    expect(payment.helcimTransactionId).toBeTruthy();
    expect(payment.cardType).toBeTruthy();
    expect(payment.cardLastFour).toMatch(/^\d{4}$/);
    expect(payment.webhookReceivedAt).toBeInstanceOf(Date);
  });

  it('builds pending payments without Helcim details', () => {
    const payment = paymentFactory.build({ status: 'pending' });
    expect(payment.helcimTransactionId).toBeNull();
    expect(payment.cardType).toBeNull();
    expect(payment.cardLastFour).toBeNull();
    expect(payment.webhookReceivedAt).toBeNull();
  });

  it('builds a list with unique IDs', () => {
    const paymentList = paymentFactory.buildList(3);
    expect(paymentList).toHaveLength(3);
    const ids = new Set(paymentList.map((p) => p.id));
    expect(ids.size).toBe(3);
  });
});
