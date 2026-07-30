// Adyen "Test your integration" checklist, end to end.
//
// Walks the five tasks Adyen's Customer Area tracks before you can go live:
//   1. Configure notification endpoint  (done in the Customer Area)
//   2. Authorize a payment
//   3. Capture a payment
//   4. Refund a payment
//   5. Cancel a payment
//
// Card data is sent in Adyen's `test_`-prefixed encrypted-field format, NOT as
// raw PAN. That distinction matters: this account's credential is (correctly)
// refused when it sends raw card numbers — that path needs PCI SAQ-D scope —
// but the encrypted-field format is the same shape Drop-in submits from the
// browser, so this exercises the path production actually uses.
//
// TEST environment only; the script refuses to run otherwise. No real money.
//
//   npx tsx scripts/verify-adyen-integration.ts
import { readFileSync } from 'fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

if (env.ADYEN_ENV !== 'TEST') {
  console.error('REFUSING TO RUN: ADYEN_ENV is not TEST. This script must never touch live money.');
  process.exit(1);
}

const API = 'https://checkout-test.adyen.com/v71';
const KEY = env.ADYEN_API_KEY;
const MERCHANT = env.ADYEN_MERCHANT_ACCOUNT;

let failures = 0;
const ok = (cond: boolean, msg: string, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};
const section = (n: string) => console.log(`\n${n}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data } as { status: number; data: Record<string, string | undefined> & Record<string, unknown> };
}

// Adyen's documented test card, in the encrypted-field format Drop-in uses.
const TEST_CARD = {
  type: 'scheme',
  encryptedCardNumber: 'test_4111111111111111',
  encryptedExpiryMonth: 'test_03',
  encryptedExpiryYear: 'test_2030',
  encryptedSecurityCode: 'test_737',
};

// No captureDelayHours: this account rejects -1 ("Auto-capture delay invalid or
// out of range"), so the account's own capture setting applies. That's the
// setting production will use anyway, which makes this the honest test.
async function authorize(label: string, holderName: string, amountCents: number) {
  const reference = `TC-${label}-${Date.now()}`;
  const { status, data } = await call('/payments', {
    merchantAccount: MERCHANT,
    amount: { value: amountCents, currency: 'USD' },
    reference,
    paymentMethod: { ...TEST_CARD, holderName },
    returnUrl: 'https://tourneycoach.com/register?probe=1',
    shopperInteraction: 'Ecommerce',
    countryCode: 'US',
    shopperEmail: 'integration-check@example.invalid',
  });
  return { status, data, reference };
}

async function main() {
  console.log('Adyen integration checklist');
  console.log(`  environment     : ${env.ADYEN_ENV}`);
  console.log(`  merchantAccount : ${MERCHANT}`);
  console.log(`  endpoint        : ${API}`);

  // ── 2. Authorize ──────────────────────────────────────────────────────────
  section('2. Authorize a payment');
  const a = await authorize('CAPTURE-FLOW', 'TourneyCoach Test', 61500);
  ok(a.status === 200, `POST /payments → HTTP ${a.status}`, String(a.data.message ?? ''));
  ok(a.data.resultCode === 'Authorised', `resultCode = ${a.data.resultCode}`);
  const authPsp = a.data.pspReference as string;
  ok(!!authPsp, `pspReference = ${authPsp}`);
  const extra = a.data.additionalData as Record<string, string> | undefined;
  if (extra) console.log(`     authCode ${extra.authCode} · ${extra.paymentMethod} ****${extra.cardSummary}`);
  // A rejected /payments call still returns a pspReference. Running capture or
  // refund against it gets a cheerful 201 and then fails silently in a webhook
  // hours later — which is exactly the kind of green tick that hides a broken
  // integration. Everything below is gated on a real authorization.
  if (a.data.resultCode !== 'Authorised' || !authPsp) {
    console.log('\n  Authorization did not succeed, so capture / refund / cancel are NOT');
    console.log('  attempted — running them against a rejected payment would report');
    console.log('  "received" and fail later in a webhook.');
    return finish();
  }

  // ── 3. Capture ────────────────────────────────────────────────────────────
  section('3. Capture a payment');
  const cap = await call(`/payments/${authPsp}/captures`, {
    merchantAccount: MERCHANT,
    amount: { value: 61500, currency: 'USD' },
    reference: `TC-CAPTURE-${Date.now()}`,
  });
  ok(cap.status === 201, `POST /payments/{psp}/captures → HTTP ${cap.status}`, String(cap.data.message ?? ''));
  ok(cap.data.status === 'received', `status = ${cap.data.status} (asynchronous — CAPTURE webhook confirms)`);
  ok(cap.data.paymentPspReference === authPsp, 'capture is bound to the authorization');
  console.log(`     capture pspReference ${cap.data.pspReference}`);

  // ── 4. Refund ─────────────────────────────────────────────────────────────
  section('4. Refund a payment');
  // A refund is only valid against a captured payment. The capture above is
  // asynchronous, so give Adyen a moment to move the payment along before
  // asking to refund it.
  await sleep(4000);
  const ref = await call(`/payments/${authPsp}/refunds`, {
    merchantAccount: MERCHANT,
    amount: { value: 61500, currency: 'USD' },
    reference: `TC-REFUND-${Date.now()}`,
    merchantRefundReason: 'CUSTOMER REQUEST',
  });
  ok(ref.status === 201, `POST /payments/{psp}/refunds → HTTP ${ref.status}`, String(ref.data.message ?? ''));
  ok(ref.data.status === 'received', `status = ${ref.data.status} (REFUND webhook confirms the outcome)`);
  console.log(`     refund pspReference ${ref.data.pspReference}`);

  // ── 5. Cancel ─────────────────────────────────────────────────────────────
  section('5. Cancel a payment');
  // Cancel only applies to an authorization that has NOT been captured, so this
  // needs its own fresh payment rather than reusing the one above.
  const b = await authorize('CANCEL-FLOW', 'TourneyCoach Cancel', 16500);
  ok(b.data.resultCode === 'Authorised', `second authorization for the cancel flow = ${b.data.resultCode}`);
  const cancelPsp = b.data.resultCode === 'Authorised' ? (b.data.pspReference as string) : '';
  if (cancelPsp) {
    const cxl = await call(`/payments/${cancelPsp}/cancels`, {
      merchantAccount: MERCHANT,
      reference: `TC-CANCEL-${Date.now()}`,
    });
    ok(cxl.status === 201, `POST /payments/{psp}/cancels → HTTP ${cxl.status}`, String(cxl.data.message ?? ''));
    ok(cxl.data.status === 'received', `status = ${cxl.data.status} (CANCELLATION webhook confirms)`);
    console.log(`     cancel pspReference ${cxl.data.pspReference}`);
  } else {
    ok(false, 'could not authorize a second payment to cancel');
  }

  // ── Webhook endpoint ──────────────────────────────────────────────────────
  section('1. Notification endpoint');
  const hookUrl = 'https://tourneycoach.com/api/webhooks/adyen';
  const res = await fetch(hookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    .catch(() => null);
  ok(!!res, `${hookUrl} is reachable`, res ? `HTTP ${res.status}` : 'unreachable');
  ok(!!env.ADYEN_WEBHOOK_HMAC_KEY, 'HMAC key is configured for signature verification');

  console.log(`\n${failures === 0 ? '✅ ADYEN CHECKLIST — ALL CALLS ACCEPTED' : `❌ ${failures} CHECK(S) FAILED`}`);
  console.log('\nAdyen processes capture/refund/cancel asynchronously. Confirm the final');
  console.log('state in Customer Area → Transactions → Payments, and via the CAPTURE /');
  console.log('REFUND / CANCELLATION webhooks.');
  process.exit(failures === 0 ? 0 : 1);
}

function finish() {
  console.log(`\n${failures === 0 ? '✅ passed' : `❌ ${failures} failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
