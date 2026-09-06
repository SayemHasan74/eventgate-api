import { describe, expect, it, vi } from 'vitest';

const configuredEnvironment = vi.hoisted(() => ({
  SSLCOMMERZ_STORE_ID: 'test-store',
  SSLCOMMERZ_STORE_PASSWORD: 'test-password',
  SSLCOMMERZ_IS_LIVE: 'false' as const,
  SSLCOMMERZ_SUCCESS_URL: 'https://example.com/success',
  SSLCOMMERZ_FAIL_URL: 'https://example.com/fail',
  SSLCOMMERZ_CANCEL_URL: 'https://example.com/cancel',
  SSLCOMMERZ_IPN_URL: 'https://example.com/ipn',
}));

vi.mock('../../src/config/env.js', () => ({ env: configuredEnvironment }));

const { SslcommerzAdapter } =
  await import('../../src/integrations/sslcommerz/sslcommerz.adapter.js');

const request = {
  merchantTransactionId: 'eg_transaction_123',
  amountPaisa: 12345,
  customer: {
    name: 'Attendee',
    email: 'attendee@example.com',
    phone: '01700000000',
    address: '42 Software Avenue',
    city: 'Dhaka',
    postalCode: '1000',
    country: 'Bangladesh',
  },
};

describe('SSLCommerz session adapter', () => {
  it('posts the documented sandbox form fields and returns a hosted URL', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'SUCCESS',
          sessionkey: 'session-key',
          GatewayPageURL: 'https://sandbox.sslcommerz.com/checkout',
        }),
        { status: 200 },
      ),
    );
    const adapter = new SslcommerzAdapter(fetcher);
    await expect(adapter.createSession(request)).resolves.toEqual({
      sessionKey: 'session-key',
      gatewayUrl: 'https://sandbox.sslcommerz.com/checkout',
    });
    const [url, options] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://sandbox.sslcommerz.com/gwprocess/v4/api.php');
    const form = options.body as URLSearchParams;
    expect(form.get('total_amount')).toBe('123.45');
    expect(form.get('currency')).toBe('BDT');
    expect(form.get('tran_id')).toBe('eg_transaction_123');
  });

  it('marks a definitive provider rejection as safe to retry sequentially', async () => {
    const adapter = new SslcommerzAdapter(
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: 'FAILED', failedreason: 'Invalid request' }), {
          status: 200,
        }),
      ),
    );
    await expect(adapter.createSession(request)).rejects.toMatchObject({ outcome: 'FAILED' });
  });

  it('marks a network failure as unknown so the application does not blindly retry it', async () => {
    const adapter = new SslcommerzAdapter(vi.fn().mockRejectedValue(new Error('network offline')));
    await expect(adapter.createSession(request)).rejects.toMatchObject({ outcome: 'UNKNOWN' });
  });

  it('uses the validation endpoint and normalizes a verified payment', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'VALID',
          val_id: 'validation-1',
          tran_id: 'eg_transaction_123',
          bank_tran_id: 'bank-transaction-1',
          amount: '123.45',
          currency: 'BDT',
        }),
        { status: 200 },
      ),
    );
    await expect(
      new SslcommerzAdapter(fetcher).validateTransaction('validation-1'),
    ).resolves.toEqual({
      validationId: 'validation-1',
      merchantTransactionId: 'eg_transaction_123',
      providerTransactionId: 'bank-transaction-1',
      amountPaisa: 12345,
      currency: 'BDT',
      status: 'VALID',
    });
    expect(fetcher.mock.calls[0]?.[0]).toContain('/validator/api/validationserverAPI.php?');
  });
});
