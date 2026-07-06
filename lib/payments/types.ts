export interface PaymentSessionParams {
  registrationId: string;
  amountCents: number;
  currency: string;
  description: string;
  returnUrl: string;
  shopperEmail?: string;
  shopperName?: string;
}

export interface PaymentSession {
  sessionId: string;
  sessionData: string;
  clientKey: string;
}

export interface RefundParams {
  pspReference: string;
  amountCents: number;
  currency: string;
  reason?: string;
}

export interface RefundResult {
  pspReference: string;
  status: 'received';
}

export interface WebhookEvent {
  eventCode: string;
  success: boolean;
  merchantReference: string;
  pspReference: string;
  /** For REFUND/CHARGEBACK events: the pspReference of the original payment */
  originalReference?: string;
  amountCents?: number;
  currency?: string;
  reason?: string;
}

export interface PaymentProcessor {
  createSession(params: PaymentSessionParams): Promise<PaymentSession>;
  refund(params: RefundParams): Promise<RefundResult>;
  parseWebhook(body: unknown, hmacSignature: string): WebhookEvent | null;
}
