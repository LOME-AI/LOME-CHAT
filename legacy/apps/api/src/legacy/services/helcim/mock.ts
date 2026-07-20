import { scheduleMockWebhook } from './mock-webhook.js';
import type { MockHelcimClient, ProcessPaymentRequest, ProcessPaymentResponse } from './types.js';

export interface MockHelcimConfig {
  webhookUrl: string;
  webhookVerifier: string;
}

export function createMockHelcimClient(config: MockHelcimConfig): MockHelcimClient {
  const processedPayments: ProcessPaymentRequest[] = [];
  let nextResponse: ProcessPaymentResponse = {
    status: 'approved',
    transactionId: 'mock-txn-' + crypto.randomUUID(),
    cardType: 'Visa',
    cardLastFour: '9990',
  };

  return {
    isMock: true,

    processPayment(request: ProcessPaymentRequest): Promise<ProcessPaymentResponse> {
      processedPayments.push({ ...request });

      const response = { ...nextResponse };
      if (response.status === 'approved') {
        response.transactionId = 'mock-txn-' + crypto.randomUUID();
        scheduleMockWebhook({
          webhookUrl: config.webhookUrl,
          webhookVerifier: config.webhookVerifier,
          transactionId: response.transactionId,
        });
      }
      return Promise.resolve(response);
    },

    setNextResponse(response: ProcessPaymentResponse): void {
      nextResponse = response;
    },

    getProcessedPayments(): ProcessPaymentRequest[] {
      return [...processedPayments];
    },

    clearProcessedPayments(): void {
      processedPayments.length = 0;
    },
  };
}
