import type { RequestHandler } from 'express';

import { env } from '../../config/env.js';
import { sendSuccess } from '../../shared/responses/api-response.js';

import { initiateCheckout, processSslcommerzCallback } from './payments.service.js';

import { getPrisma } from '../../lib/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
export const readPaymentAttempt: RequestHandler = async (request, response) => {
  const attempt = await getPrisma().paymentAttempt.findFirst({
    where: { id: request.params.attemptId as string, order: { attendeeId: request.auth.id } },
    select: {
      id: true,
      orderId: true,
      merchantTransactionId: true,
      amountPaisa: true,
      currency: true,
      status: true,
      initiatedAt: true,
      completedAt: true,
    },
  });
  if (!attempt)
    throw new AppError({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Payment attempt not found',
      errors: [{ code: 'NOT_FOUND', message: 'Payment attempt not found.' }],
    });
  response.setHeader('Cache-Control', 'private, no-store');
  sendSuccess(response, 200, 'Payment attempt retrieved', attempt);
};

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
