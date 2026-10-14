import { env } from '../../config/env.js';
import { AppError } from '../../shared/errors/app-error.js';

const sandboxEndpoint = 'https://sandbox.sslcommerz.com/gwprocess/v4/api.php';
const liveEndpoint = 'https://securepay.sslcommerz.com/gwprocess/v4/api.php';
const sandboxValidationEndpoint =
  'https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php';
const liveValidationEndpoint =
  'https://securepay.sslcommerz.com/validator/api/validationserverAPI.php';
const refundEndpoint = (live: boolean) =>
  `${live ? 'https://securepay.sslcommerz.com' : 'https://sandbox.sslcommerz.com'}/validator/api/merchantTransIDvalidationAPI.php`;

type Fetcher = typeof fetch;

export type SslcommerzSessionRequest = {
  merchantTransactionId: string;
  amountPaisa: number;
  productName: string;
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

const trustedCheckoutUrl = (value: string, live: boolean): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (!url.port || url.port === '443') &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.hostname ===
        (live
          ? 'securepay.sslcommerz.com'
          : 'sandbox.sslcommerz.com') &&
      ![...url.searchParams.keys()].some((key) =>
        /(passwd|password|secret|access[_-]?token|refresh[_-]?token|api[_-]?key|credential)/i.test(
          key,
        ),
      )
    );
  } catch {
    return false;
  }
};

export type SslcommerzValidation = {
  validationId: string;
  merchantTransactionId: string;
  providerTransactionId: string;
  amountPaisa: number;
  currency: string;
  status: string;
};

export type SslcommerzRefundInitiation = {
  providerRefundId: string;
  status: 'PROCESSING' | 'FAILED';
};
export type SslcommerzRefundStatus = 'SUCCEEDED' | 'PROCESSING' | 'FAILED';

export class SslcommerzProviderError extends Error {
  public constructor(
    message: string,
    public readonly outcome: 'FAILED' | 'UNKNOWN',
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}

export type SslcommerzEnvironment = 'LIVE' | 'DEMO';

const credentialsFor = (environment: SslcommerzEnvironment) =>
  environment === 'DEMO'
    ? { storeId: env.DEMO_SSLCOMMERZ_STORE_ID, password: env.DEMO_SSLCOMMERZ_STORE_PASSWORD, live: false }
    : { storeId: env.SSLCOMMERZ_STORE_ID, password: env.SSLCOMMERZ_STORE_PASSWORD, live: env.SSLCOMMERZ_IS_LIVE === 'true' };

export const assertSslcommerzConfigured = (environment: SslcommerzEnvironment = 'LIVE'): void => {
  const credentials = credentialsFor(environment);
  const required = [
    credentials.storeId,
    credentials.password,
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
          message: environment === 'DEMO'
            ? 'Configure separate demo SSLCommerz sandbox credentials before enabling demo checkout.'
            : 'Configure SSLCommerz credentials and callback URLs.',
        },
      ],
    });
  }
};

export class SslcommerzAdapter {
  public constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly paymentEnvironment: SslcommerzEnvironment = 'LIVE',
    private readonly expectedMerchantIdentity?: string | null,
  ) {}

  private get credentials() {
    const credentials = credentialsFor(this.paymentEnvironment);
    if (this.expectedMerchantIdentity && credentials.storeId !== this.expectedMerchantIdentity)
      throw new AppError({ statusCode: 503, code: 'PAYMENT_MERCHANT_CONFIGURATION_MISMATCH', message: 'The configured payment merchant does not match this payment attempt.' });
    return credentials;
  }

  public async lookupTransaction(input: {
    merchantTransactionId: string;
    sessionKey?: string | null;
  }): Promise<
    { status: 'CAPTURED'; validationId: string } | { status: 'FAILED' | 'PENDING' | 'UNKNOWN' }
  > {
    assertSslcommerzConfigured(this.paymentEnvironment);
    const credentials = this.credentials;
    const query = new URLSearchParams({
      store_id: credentials.storeId!,
      store_passwd: credentials.password!,
      format: 'json',
      ...(input.sessionKey
        ? { sessionkey: input.sessionKey }
        : { tran_id: input.merchantTransactionId }),
    });
    // Official session/merchant query API. Absence of a transaction is NOT evidence of failure.
    const response = await this.fetcher(
      `${refundEndpoint(credentials.live)}?${query}`,
      {
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) throw new SslcommerzProviderError('Payment lookup unavailable.', 'UNKNOWN');
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object') return { status: 'UNKNOWN' };
    const result = payload as Record<string, unknown>;
    if (result.APIConnect !== 'DONE') return { status: 'UNKNOWN' };
    const rows = input.sessionKey ? [result] : Array.isArray(result.element) ? result.element : [];
    if (!rows.length || rows.length > 100) return { status: 'UNKNOWN' };
    const records: Record<string, unknown>[] = [];
    for (const row of rows) {
      if (
        !row ||
        typeof row !== 'object' ||
        row.tran_id !== input.merchantTransactionId ||
        (input.sessionKey && row.sessionkey !== input.sessionKey)
      )
        return { status: 'UNKNOWN' };
      records.push(row as Record<string, unknown>);
    }
    const captures = records.filter((row) => row.status === 'VALID' || row.status === 'VALIDATED');
    const validationIds = [...new Set(captures.map((row) => row.val_id))];
    if (captures.length) {
      if (validationIds.length !== 1 || typeof validationIds[0] !== 'string' || !validationIds[0])
        return { status: 'UNKNOWN' };
      return { status: 'CAPTURED', validationId: validationIds[0] };
    }
    if (records.every((row) => row.status === 'FAILED')) return { status: 'FAILED' };
    if (records.every((row) => row.status === 'PENDING' || row.status === 'FAILED'))
      return { status: 'PENDING' };
    return { status: 'UNKNOWN' };
  }

  public async createSession(input: SslcommerzSessionRequest): Promise<SslcommerzSession> {
    assertSslcommerzConfigured(this.paymentEnvironment);
    const credentials = this.credentials;
    const body = new URLSearchParams({
      store_id: credentials.storeId!,
      store_passwd: credentials.password!,
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
      product_name: input.productName,
      product_category: 'event-ticket',
      product_profile: 'general',
      value_a: input.merchantTransactionId,
    });
    let response: Response;
    try {
      response = await this.fetcher(
        credentials.live ? liveEndpoint : sandboxEndpoint,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch (cause) {
      throw new SslcommerzProviderError(
        'SSLCommerz session request outcome is unknown.',
        'UNKNOWN',
        cause,
      );
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
      throw new SslcommerzProviderError(
        'SSLCommerz did not confirm session creation.',
        result.status === 'FAILED' ? 'FAILED' : 'UNKNOWN',
      );
    }
    if (!trustedCheckoutUrl(gatewayUrl, credentials.live)) {
      // A session may already exist at the provider. Never disclose the address or retry blindly.
      throw new SslcommerzProviderError(
        'SSLCommerz returned an unsafe checkout address.',
        'UNKNOWN',
      );
    }
    return { sessionKey, gatewayUrl };
  }

  public async validateTransaction(validationId: string): Promise<SslcommerzValidation> {
    assertSslcommerzConfigured(this.paymentEnvironment);
    const credentials = this.credentials;
    const query = new URLSearchParams({
      val_id: validationId,
      store_id: credentials.storeId!,
      store_passwd: credentials.password!,
      v: '1',
      format: 'json',
    });
    let response: Response;
    try {
      response = await this.fetcher(
        `${credentials.live ? liveValidationEndpoint : sandboxValidationEndpoint}?${query.toString()}`,
        { signal: AbortSignal.timeout(15_000) },
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
      returnedValidationId !== validationId ||
      !currency ||
      !status ||
      !Number.isFinite(amount) ||
      !Number.isSafeInteger(Math.round(amount * 100)) ||
      amount <= 0
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

  public async initiateRefund(input: {
    bankTransactionId: string;
    refundTransactionId: string;
    amountPaisa: number;
    remarks: string;
  }): Promise<SslcommerzRefundInitiation> {
    assertSslcommerzConfigured(this.paymentEnvironment);
    const credentials = this.credentials;
    const query = new URLSearchParams({
      bank_tran_id: input.bankTransactionId,
      refund_trans_id: input.refundTransactionId,
      refund_amount: (input.amountPaisa / 100).toFixed(2),
      refund_remarks: input.remarks,
      refe_id: input.refundTransactionId,
      store_id: credentials.storeId!,
      store_passwd: credentials.password!,
      v: '1',
      format: 'json',
    });
    let response: Response;
    try {
      response = await this.fetcher(
        `${refundEndpoint(credentials.live)}?${query}`,
        { signal: AbortSignal.timeout(15_000) },
      );
    } catch (cause) {
      throw new SslcommerzProviderError(
        'SSLCommerz refund initiation outcome is unknown.',
        'UNKNOWN',
        cause,
      );
    }
    if (!response.ok)
      throw new SslcommerzProviderError(
        `SSLCommerz refund initiation failed with HTTP ${response.status}.`,
        'UNKNOWN',
      );
    const result = (await response.json()) as Record<string, unknown>;
    const reference = typeof result.refund_ref_id === 'string' ? result.refund_ref_id : undefined;
    const status = typeof result.status === 'string' ? result.status.toLowerCase() : '';
    if (result.APIConnect !== 'DONE')
      throw new SslcommerzProviderError(
        'Provider refund request could not be confirmed.',
        'UNKNOWN',
      );
    if (
      (status === 'success' || status === 'processing') &&
      reference &&
      result.bank_tran_id === input.bankTransactionId
    )
      return { providerRefundId: reference, status: 'PROCESSING' };
    if (status === 'failed')
      throw new SslcommerzProviderError('Provider rejected refund initiation.', 'FAILED');
    throw new SslcommerzProviderError(
      'SSLCommerz returned an invalid refund initiation response.',
      'UNKNOWN',
    );
  }

  public async getRefundStatus(
    providerRefundId: string,
    bankTransactionId: string,
  ): Promise<SslcommerzRefundStatus> {
    assertSslcommerzConfigured(this.paymentEnvironment);
    const credentials = this.credentials;
    const query = new URLSearchParams({
      refund_ref_id: providerRefundId,
      store_id: credentials.storeId!,
      store_passwd: credentials.password!,
      format: 'json',
    });
    let response: Response;
    try {
      response = await this.fetcher(
        `${refundEndpoint(credentials.live)}?${query}`,
        { signal: AbortSignal.timeout(15_000) },
      );
    } catch (cause) {
      throw new SslcommerzProviderError('SSLCommerz refund status is unknown.', 'UNKNOWN', cause);
    }
    if (!response.ok)
      throw new SslcommerzProviderError(
        `SSLCommerz refund status failed with HTTP ${response.status}.`,
        'UNKNOWN',
      );
    const result = (await response.json()) as Record<string, unknown>;
    if (
      result.APIConnect !== 'DONE' ||
      result.refund_ref_id !== providerRefundId ||
      result.bank_tran_id !== bankTransactionId
    )
      throw new SslcommerzProviderError(
        'Provider refund identity could not be confirmed.',
        'UNKNOWN',
      );
    const status = typeof result.status === 'string' ? result.status.toLowerCase() : '';
    if (status === 'refunded') return 'SUCCEEDED';
    if (status === 'processing') return 'PROCESSING';
    if (status === 'cancelled' || status === 'failed') return 'FAILED';
    throw new SslcommerzProviderError(
      'SSLCommerz returned an invalid refund status response.',
      'UNKNOWN',
    );
  }
}
