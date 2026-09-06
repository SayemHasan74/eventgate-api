import type { RequestHandler } from 'express';

import { sendSuccess } from '../../shared/responses/api-response.js';

import { initiateCheckout } from './payments.service.js';

export const beginCheckout: RequestHandler = async (request, response) => {
  sendSuccess(
    response,
    201,
    'SSLCommerz checkout session created',
    await initiateCheckout(request.auth.id, request.params.orderId as string),
  );
};
