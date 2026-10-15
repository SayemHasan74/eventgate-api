import type { RequestHandler } from 'express';
import { paginationMeta } from '../../shared/responses/pagination.js';
import { refundListQuerySchema } from './refunds.schemas.js';
import { sendList, sendSuccess } from '../../shared/responses/api-response.js';
import {
  listRefunds,
  getRefund,
  requestRefund,
  reviewRefund,
  queueRefundRetry,
} from './refunds.service.js';

export const createRefundRequest: RequestHandler = async (request, response) => {
  const refund = await requestRefund(
    request.auth.id,
    request.params.orderId as string,
    request.body?.userMessage,
  );
  sendSuccess(response, 201, 'Refund requested', await getRefund(request.auth, refund.id));
};
export const readRefunds: RequestHandler = async (request, response) => {
  const query = refundListQuerySchema.parse(request.query);
  const result = await listRefunds(request.auth, query);
  sendList(response, 'Refunds retrieved', result.refunds, paginationMeta(query, result.total));
};
export const readRefund: RequestHandler = async (request, response) =>
  sendSuccess(
    response,
    200,
    'Refund retrieved',
    await getRefund(request.auth, request.params.refundId as string),
  );
export const reviewRefundRequest: RequestHandler = async (request, response) => {
  await reviewRefund(request.auth.id, request.params.refundId as string, request.body);
  sendSuccess(
    response,
    200,
    'Refund reviewed',
    await getRefund(request.auth, request.params.refundId as string),
  );
};
export const retryRefund: RequestHandler = async (request, response) => {
  await queueRefundRetry(request.auth.id, request.params.refundId as string, request.body.reason);
  sendSuccess(response, 202, 'Refund retry queued', null);
};
