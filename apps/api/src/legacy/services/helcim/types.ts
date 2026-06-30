export interface ProcessPaymentRequest {
  cardToken: string;
  customerCode: string; // Required: card tokens are linked to customer codes
  amount: string; // USD amount as decimal string, e.g., "10.00000000"
  paymentId: string; // Used as idempotency key
  ipAddress: string; // Required by Helcim API for card token purchases
}

export interface ProcessPaymentResponse {
  status: 'approved' | 'declined';
  transactionId?: string | null;
  errorMessage?: string | undefined;
  cardType?: string | undefined;
  cardLastFour?: string | undefined;
  /** Diagnostic info for debugging failed payments (only present on declined) */
  debugInfo?: {
    httpStatus: number;
    responseBody: unknown;
  };
}

export interface HelcimClient {
  processPayment(request: ProcessPaymentRequest): Promise<ProcessPaymentResponse>;
  readonly isMock: boolean;
}

export interface MockHelcimClient extends HelcimClient {
  setNextResponse(response: ProcessPaymentResponse): void;
  getProcessedPayments(): ProcessPaymentRequest[];
  clearProcessedPayments(): void;
}
