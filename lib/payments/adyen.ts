import {
  Client,
  CheckoutAPI,
  EnvironmentEnum,
  hmacValidator,
} from '@adyen/api-library';
import type { NotificationRequestItem } from '@adyen/api-library/lib/src/typings/notification/notificationRequestItem';
import type { PaymentProcessor, PaymentSessionParams, PaymentSession, RefundParams, RefundResult, WebhookEvent } from './types';

function buildClient(): Client {
  const env = (process.env.ADYEN_ENV === 'LIVE') ? EnvironmentEnum.LIVE : EnvironmentEnum.TEST;
  return new Client({
    apiKey: process.env.ADYEN_API_KEY!,
    environment: env,
  });
}

export class AdyenProcessor implements PaymentProcessor {
  async createSession(params: PaymentSessionParams): Promise<PaymentSession> {
    const client = buildClient();
    const checkout = new CheckoutAPI(client);

    const [firstName, ...rest] = (params.shopperName ?? '').split(' ');
    const lastName = rest.join(' ') || '-';

    const res = await checkout.PaymentsApi.sessions({
      merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT!,
      amount: { value: params.amountCents, currency: params.currency },
      reference: params.registrationId,
      returnUrl: params.returnUrl,
      shopperEmail: params.shopperEmail ?? undefined,
      shopperName: params.shopperName ? { firstName, lastName } : undefined,
      countryCode: 'US',
      channel: 'Web' as Parameters<typeof checkout.PaymentsApi.sessions>[0]['channel'],
      metadata: { registrationId: params.registrationId },
    });

    return {
      sessionId: res.id,
      sessionData: res.sessionData!,
      clientKey: process.env.ADYEN_CLIENT_KEY!,
    };
  }

  async refund(params: RefundParams): Promise<RefundResult> {
    const client = buildClient();
    const checkout = new CheckoutAPI(client);

    const res = await checkout.ModificationsApi.refundCapturedPayment(
      params.pspReference,
      {
        merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT!,
        amount: { value: params.amountCents, currency: params.currency },
        reference: params.reason ?? 'Organizer refund',
      }
    );

    return {
      pspReference: res.pspReference,
      status: 'received',
    };
  }

  parseWebhook(body: unknown, hmacSignature: string): WebhookEvent | null {
    const hmacKey = process.env.ADYEN_WEBHOOK_HMAC_KEY;
    type NotifBody = { notificationItems?: { NotificationRequestItem: Record<string, unknown> }[] };
    const notification = (body as NotifBody)?.notificationItems?.[0]?.NotificationRequestItem;

    if (!notification) return null;

    if (hmacKey) {
      const validator = new hmacValidator();
      if (!validator.validateHMAC(notification as unknown as NotificationRequestItem, hmacKey)) {
        return null;
      }
    }

    const amount = notification.amount as { value?: number; currency?: string } | undefined;

    return {
      eventCode: notification.eventCode as string,
      success: notification.success === 'true',
      merchantReference: notification.merchantReference as string,
      pspReference: notification.pspReference as string,
      originalReference: notification.originalReference as string | undefined,
      amountCents: amount?.value,
      currency: amount?.currency,
      reason: notification.reason as string | undefined,
    };
  }
}
