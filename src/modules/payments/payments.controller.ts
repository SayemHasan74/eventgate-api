import type { RequestHandler } from 'express';

import { env } from '../../config/env.js';
import { sendSuccess } from '../../shared/responses/api-response.js';

import { initiateCheckout, processSslcommerzCallback } from './payments.service.js';

import { getPayment } from '../reports/workspace-reads.service.js';
export const readPaymentAttempt: RequestHandler = async (request, response) => {
  const attempt = await getPayment(request.params.attemptId as string, request.auth.id);
  response.setHeader('Cache-Control', 'private, no-store');
  sendSuccess(response, 200, 'Payment attempt retrieved', attempt);
};

export const beginCheckout: RequestHandler = async (request, response) => {
  const result = await initiateCheckout(
    request.auth.id,
    request.params.orderId as string,
    request.get('Idempotency-Key')!,
  );
  response.setHeader('Cache-Control', 'private, no-store');
  sendSuccess(
    response,
    result.statusCode,
    result.statusCode === 202
      ? 'Payment status needs confirmation'
      : 'SSLCommerz checkout available',
    result.data,
  );
};

export const receiveSslcommerzCallback =
  (type: 'IPN' | 'SUCCESS' | 'FAIL' | 'CANCEL'): RequestHandler =>
  async (request, response) => {
    // SSLCommerz expects a quick acknowledgement. Its callback payload is persisted first;
    // payment state is based only on the subsequent validation API response.
    await processSslcommerzCallback(type, request.body as Record<string, unknown>, undefined, true);

    // IPN is SSLCommerz's server-to-server callback and needs a plain acknowledgement.
    // Browser callbacks should return the customer to EventGate, not expose an internal
    // gateway acknowledgement page.
    if (type === 'IPN') {
      response.status(200).send('OK');
      return;
    }

    const destination = type === 'SUCCESS' ? '/payment/success' : '/payment/cancel';
    response.redirect(303, `${env.FRONTEND_URL.replace(/\/$/, '')}${destination}`);
  };
