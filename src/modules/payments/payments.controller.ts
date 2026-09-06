import type { RequestHandler } from 'express';

import { sendSuccess } from '../../shared/responses/api-response.js';

import { initiateCheckout, processSslcommerzCallback } from './payments.service.js';

export const beginCheckout: RequestHandler = async (request, response) => {
  sendSuccess(
    response,
    201,
    'SSLCommerz checkout session created',
    await initiateCheckout(request.auth.id, request.params.orderId as string),
  );
};

export const receiveSslcommerzCallback =
  (type: 'IPN' | 'SUCCESS' | 'FAIL' | 'CANCEL'): RequestHandler =>
  async (request, response) => {
    // SSLCommerz expects a quick acknowledgement. Its callback payload is persisted first;
    // payment state is based only on the subsequent validation API response.
    await processSslcommerzCallback(type, request.body as Record<string, unknown>);
    response.status(200).send('OK');
  };
