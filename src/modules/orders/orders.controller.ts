import type { RequestHandler } from 'express';

import { AppError } from '../../shared/errors/app-error.js';
import { sendList, sendSuccess } from '../../shared/responses/api-response.js';

import type { CreateOrderInput, OrderListQuery } from './orders.schemas.js';
import { cancelOrder, createOrder, getOrder, listOrders } from './orders.service.js';

const requireIdempotencyKey = (request: Parameters<RequestHandler>[0]): string => {
  const key = request.header('idempotency-key')?.trim();
  if (!key || key.length > 255) {
    throw new AppError({
      statusCode: 400,
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: 'Idempotency-Key header is required',
      errors: [
        { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Provide a 1-255 character Idempotency-Key.' },
      ],
    });
  }
  return key;
};

export const addOrder: RequestHandler = async (request, response) => {
  sendSuccess(
    response,
    201,
    'Order created and inventory reserved',
    await createOrder(
      request.auth.id,
      requireIdempotencyKey(request),
      request.body as CreateOrderInput,
    ),
  );
};

export const readOrders: RequestHandler = async (request, response) => {
  const result = await listOrders(request.auth.id, request.query as unknown as OrderListQuery);
  sendList(response, 'Orders retrieved', result.orders, {
    page: result.page,
    limit: result.limit,
    total: result.total,
    totalPages: Math.ceil(result.total / result.limit),
  });
};

export const readOrder: RequestHandler = async (request, response) => {
  sendSuccess(
    response,
    200,
    'Order retrieved',
    await getOrder(request.auth.id, request.params.orderId as string),
  );
};

export const cancelManagedOrder: RequestHandler = async (request, response) => {
  await cancelOrder(request.auth.id, request.params.orderId as string);
  sendSuccess(response, 200, 'Order cancelled and inventory released', null);
};
