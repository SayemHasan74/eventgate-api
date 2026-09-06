import { env } from '../../config/env.js';
import { AppError } from '../../shared/errors/app-error.js';

const sandboxEndpoint = 'https://sandbox.sslcommerz.com/gwprocess/v4/api.php';
const liveEndpoint = 'https://securepay.sslcommerz.com/gwprocess/v4/api.php';
const sandboxValidationEndpoint =
  'https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php';
const liveValidationEndpoint =
  'https://securepay.sslcommerz.com/validator/api/validationserverAPI.php';

type Fetcher = typeof fetch;

export type SslcommerzSessionRequest = {
  merchantTransactionId: string;
  amountPaisa: number;
  customer: {
    name: string;
    email: string;
    phone: string;
    address: string;
    city: string;
    postalCode: string;
    country: string;
  };
};

export type SslcommerzSession = { sessionKey: string; gatewayUrl: string };

export type SslcommerzValidation = {
  validationId: string;
  merchantTransactionId: string;
  providerTransactionId: string;
  amountPaisa: number;
  currency: string;
  status: string;
};

export class SslcommerzProviderError extends Error {
  public constructor(
    message: string,
    public readonly outcome: 'FAILED' | 'UNKNOWN',
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}

export const assertSslcommerzConfigured = (): void => {
  const required = [
    env.SSLCOMMERZ_STORE_ID,
    env.SSLCOMMERZ_STORE_PASSWORD,
    env.SSLCOMMERZ_SUCCESS_URL,
    env.SSLCOMMERZ_FAIL_URL,
    env.SSLCOMMERZ_CANCEL_URL,
    env.SSLCOMMERZ_IPN_URL,
  ];
  if (required.some((value) => !value)) {
    throw new AppError({
      statusCode: 503,
      code: 'PAYMENT_CONFIGURATION_ERROR',
      message: 'SSLCommerz checkout is not configured',
      errors: [
        {
          code: 'PAYMENT_CONFIGURATION_ERROR',
          message: 'Configure SSLCommerz credentials and callback URLs.',
        },
      ],
    });
  }
};

export class SslcommerzAdapter {
  public constructor(private readonly fetcher: Fetcher = fetch) {}

  public async createSession(input: SslcommerzSessionRequest): Promise<SslcommerzSession> {
    assertSslcommerzConfigured();
    const body = new URLSearchParams({
      store_id: env.SSLCOMMERZ_STORE_ID!,
      store_passwd: env.SSLCOMMERZ_STORE_PASSWORD!,
      total_amount: (input.amountPaisa / 100).toFixed(2),
      currency: 'BDT',
      tran_id: input.merchantTransactionId,
      success_url: env.SSLCOMMERZ_SUCCESS_URL!,
      fail_url: env.SSLCOMMERZ_FAIL_URL!,
      cancel_url: env.SSLCOMMERZ_CANCEL_URL!,
      ipn_url: env.SSLCOMMERZ_IPN_URL!,
      cus_name: input.customer.name,
      cus_email: input.customer.email,
      cus_add1: input.customer.address,
      cus_city: input.customer.city,
      cus_postcode: input.customer.postalCode,
      cus_country: input.customer.country,
      cus_phone: input.customer.phone,
      shipping_method: 'NO',
      product_name: 'EventGate ticket order',
      product_category: 'event-ticket',
      product_profile: 'general',
      value_a: input.merchantTransactionId,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let response: Response;
    try {
      response = await this.fetcher(
        env.SSLCOMMERZ_IS_LIVE === 'true' ? liveEndpoint : sandboxEndpoint,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
          signal: controller.signal,
        },
      );
    } catch (cause) {
      throw new SslcommerzProviderError(
        'SSLCommerz session request outcome is unknown.',
        'UNKNOWN',
        cause,
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new SslcommerzProviderError(
        `SSLCommerz session request failed with HTTP ${response.status}.`,
        'UNKNOWN',
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new SslcommerzProviderError('SSLCommerz returned invalid JSON.', 'UNKNOWN', cause);
    }
    if (!payload || typeof payload !== 'object') {
      throw new SslcommerzProviderError(
        'SSLCommerz returned an invalid session response.',
        'UNKNOWN',
      );
    }
    const result = payload as Record<string, unknown>;
    const sessionKey = typeof result.sessionkey === 'string' ? result.sessionkey : undefined;
    const gatewayUrl =
      typeof result.GatewayPageURL === 'string' ? result.GatewayPageURL : undefined;
    if (result.status !== 'SUCCESS' || !sessionKey || !gatewayUrl) {
      const detail =
        typeof result.failedreason === 'string'
          ? result.failedreason
          : 'Session creation was rejected.';
      throw new SslcommerzProviderError(`SSLCommerz rejected the session: ${detail}`, 'FAILED');
    }
    return { sessionKey, gatewayUrl };
  }

  public async validateTransaction(validationId: string): Promise<SslcommerzValidation> {
    assertSslcommerzConfigured();
    const query = new URLSearchParams({
      val_id: validationId,
      store_id: env.SSLCOMMERZ_STORE_ID!,
      store_passwd: env.SSLCOMMERZ_STORE_PASSWORD!,
      v: '1',
      format: 'json',
    });
    let response: Response;
    try {
      response = await this.fetcher(
        `${env.SSLCOMMERZ_IS_LIVE === 'true' ? liveValidationEndpoint : sandboxValidationEndpoint}?${query.toString()}`,
      );
    } catch (cause) {
      throw new SslcommerzProviderError(
        'SSLCommerz validation outcome is unknown.',
        'UNKNOWN',
        cause,
      );
    }
    if (!response.ok)
      throw new SslcommerzProviderError(
        `SSLCommerz validation failed with HTTP ${response.status}.`,
        'UNKNOWN',
      );
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new SslcommerzProviderError(
        'SSLCommerz validation returned invalid JSON.',
        'UNKNOWN',
        cause,
      );
    }
    if (!payload || typeof payload !== 'object')
      throw new SslcommerzProviderError('SSLCommerz validation response is invalid.', 'UNKNOWN');
    const result = payload as Record<string, unknown>;
    const amount =
      typeof result.amount === 'string' || typeof result.amount === 'number'
        ? Number(result.amount)
        : NaN;
    const transactionId = typeof result.tran_id === 'string' ? result.tran_id : undefined;
    const providerTransactionId =
      typeof result.bank_tran_id === 'string' ? result.bank_tran_id : undefined;
    const returnedValidationId = typeof result.val_id === 'string' ? result.val_id : undefined;
    const currency = typeof result.currency === 'string' ? result.currency : undefined;
    const status = typeof result.status === 'string' ? result.status : undefined;
    if (
      !transactionId ||
      !providerTransactionId ||
      !returnedValidationId ||
      !currency ||
      !status ||
      !Number.isFinite(amount)
    )
      throw new SslcommerzProviderError(
        'SSLCommerz validation response is missing required fields.',
        'UNKNOWN',
      );
    return {
      validationId: returnedValidationId,
      merchantTransactionId: transactionId,
      providerTransactionId,
      amountPaisa: Math.round(amount * 100),
      currency,
      status,
    };
  }
}
