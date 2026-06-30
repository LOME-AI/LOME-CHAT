import { describe, it, expect, vi } from 'vitest';
import { createMockHelcimClient } from './mock.js';
import * as mockWebhook from './mock-webhook.js';
import type { ProcessPaymentRequest, ProcessPaymentResponse } from './types.js';

describe('createMockHelcimClient', () => {
  const testConfig = {
    webhookUrl: 'http://localhost:8787/webhooks/payment',
    webhookVerifier: 'test-verifier',
  };

  const testPayment: ProcessPaymentRequest = {
    cardToken: 'test-token-123',
    customerCode: 'CST1234',
    amount: '10.00000000',
    paymentId: 'payment-uuid-123',
    ipAddress: '192.168.1.1',
  };

  describe('isMock property', () => {
    it('returns true for mock client', () => {
      const client = createMockHelcimClient(testConfig);

      expect(client.isMock).toBe(true);
    });
  });

  describe('processPayment', () => {
    it('returns approved status by default', async () => {
      const client = createMockHelcimClient(testConfig);

      const result = await client.processPayment(testPayment);

      expect(result.status).toBe('approved');
    });

    it('returns transaction ID for approved payments', async () => {
      const client = createMockHelcimClient(testConfig);

      const result = await client.processPayment(testPayment);

      expect(result.transactionId).toBeDefined();
      expect(result.transactionId).toMatch(/^mock-txn-/);
    });

    it('returns default card type and last four', async () => {
      const client = createMockHelcimClient(testConfig);

      const result = await client.processPayment(testPayment);

      expect(result.cardType).toBe('Visa');
      expect(result.cardLastFour).toBe('9990');
    });

    it('stores processed payments for retrieval', async () => {
      const client = createMockHelcimClient(testConfig);

      await client.processPayment(testPayment);

      const processed = client.getProcessedPayments();
      expect(processed).toHaveLength(1);
      expect(processed[0]).toEqual(testPayment);
    });

    it('stores multiple payments in order', async () => {
      const client = createMockHelcimClient(testConfig);
      const payment1 = { ...testPayment, paymentId: 'payment-1' };
      const payment2 = { ...testPayment, paymentId: 'payment-2' };

      await client.processPayment(payment1);
      await client.processPayment(payment2);

      const processed = client.getProcessedPayments();
      expect(processed).toHaveLength(2);
      expect(processed[0]?.paymentId).toBe('payment-1');
      expect(processed[1]?.paymentId).toBe('payment-2');
    });

    it('generates unique transaction IDs for each payment', async () => {
      const client = createMockHelcimClient(testConfig);

      const result1 = await client.processPayment(testPayment);
      const result2 = await client.processPayment(testPayment);

      expect(result1.transactionId).not.toBe(result2.transactionId);
    });
  });

  describe('setNextResponse', () => {
    it('allows setting a declined response', async () => {
      const client = createMockHelcimClient(testConfig);
      const declinedResponse: ProcessPaymentResponse = {
        status: 'declined',
        errorMessage: 'Insufficient funds',
      };

      client.setNextResponse(declinedResponse);
      const result = await client.processPayment(testPayment);

      expect(result.status).toBe('declined');
      expect(result.errorMessage).toBe('Insufficient funds');
    });

    it('allows setting a custom approved response with custom card details', async () => {
      const client = createMockHelcimClient(testConfig);
      const customResponse: ProcessPaymentResponse = {
        status: 'approved',
        transactionId: 'custom-txn-123',
        cardType: 'MasterCard',
        cardLastFour: '1234',
      };

      client.setNextResponse(customResponse);
      const result = await client.processPayment(testPayment);

      expect(result.status).toBe('approved');
      // Transaction ID is always uniquely generated
      expect(result.transactionId).toMatch(/^mock-txn-/);
      expect(result.cardType).toBe('MasterCard');
      expect(result.cardLastFour).toBe('1234');
    });

    it('persists response for multiple payments', async () => {
      const client = createMockHelcimClient(testConfig);
      const declinedResponse: ProcessPaymentResponse = {
        status: 'declined',
        errorMessage: 'Card expired',
      };

      client.setNextResponse(declinedResponse);
      const result1 = await client.processPayment(testPayment);
      const result2 = await client.processPayment(testPayment);

      expect(result1.status).toBe('declined');
      expect(result2.status).toBe('declined');
    });
  });

  describe('getProcessedPayments', () => {
    it('returns empty array when no payments processed', () => {
      const client = createMockHelcimClient(testConfig);

      expect(client.getProcessedPayments()).toEqual([]);
    });

    it('returns a copy of the payments array', async () => {
      const client = createMockHelcimClient(testConfig);
      await client.processPayment(testPayment);

      const payments1 = client.getProcessedPayments();
      const payments2 = client.getProcessedPayments();

      expect(payments1).not.toBe(payments2);
      expect(payments1).toEqual(payments2);
    });
  });

  describe('clearProcessedPayments', () => {
    it('clears all stored payments', async () => {
      const client = createMockHelcimClient(testConfig);
      await client.processPayment(testPayment);
      await client.processPayment(testPayment);

      client.clearProcessedPayments();

      expect(client.getProcessedPayments()).toEqual([]);
    });
  });

  describe('webhook scheduling', () => {
    it('schedules webhook after successful payment when config provided', async () => {
      const scheduleMockWebhookSpy = vi
        .spyOn(mockWebhook, 'scheduleMockWebhook')
        .mockImplementation(() => {});

      const client = createMockHelcimClient(testConfig);

      const result = await client.processPayment(testPayment);

      expect(result.status).toBe('approved');
      expect(scheduleMockWebhookSpy).toHaveBeenCalledTimes(1);
      expect(scheduleMockWebhookSpy).toHaveBeenCalledWith({
        webhookUrl: testConfig.webhookUrl,
        webhookVerifier: testConfig.webhookVerifier,
        transactionId: result.transactionId,
      });

      scheduleMockWebhookSpy.mockRestore();
    });

    it('does not schedule webhook when payment is declined', async () => {
      const scheduleMockWebhookSpy = vi
        .spyOn(mockWebhook, 'scheduleMockWebhook')
        .mockImplementation(() => {});

      const client = createMockHelcimClient(testConfig);
      client.setNextResponse({
        status: 'declined',
        errorMessage: 'Insufficient funds',
      });

      await client.processPayment(testPayment);

      expect(scheduleMockWebhookSpy).not.toHaveBeenCalled();

      scheduleMockWebhookSpy.mockRestore();
    });
  });
});
