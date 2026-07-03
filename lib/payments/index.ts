import type { PaymentProcessor } from './types';

let _processor: PaymentProcessor | null = null;

export async function getPaymentProcessor(): Promise<PaymentProcessor> {
  if (_processor) return _processor;

  const provider = process.env.PAYMENT_PROVIDER ?? 'adyen';

  if (provider === 'adyen') {
    const { AdyenProcessor } = await import('./adyen');
    _processor = new AdyenProcessor();
  } else {
    throw new Error(`Unknown payment provider: ${provider}`);
  }

  return _processor;
}

export type { PaymentProcessor, PaymentSessionParams, PaymentSession, RefundParams, RefundResult, WebhookEvent } from './types';
