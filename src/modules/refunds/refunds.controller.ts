import type { RequestHandler } from 'express';
import { paginationMeta } from '../../shared/responses/pagination.js';
import { refundListQuerySchema } from './refunds.schemas.js';
import { sendList, sendSuccess } from '../../shared/responses/api-response.js';
import {
  listRefunds,
  getRefund,
  requestRefund,
  reviewRefund,
  startRefund,
} from './refunds.service.js';
import { getPrisma } from '../../lib/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import { financialConflict } from './capture-refund.js';

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
export const reviewRefundRequest: RequestHandler = async (request, response) =>
  sendSuccess(
    response,
    200,
    'Refund reviewed',
    await reviewRefund(request.auth.id, request.params.refundId as string, request.body),
  );
export const retryRefund: RequestHandler = async (request, response) => {
  const refund = await getPrisma().refund.findUnique({
    where: { id: request.params.refundId as string },
  });
  if (!refund)
    throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: 'Refund not found.' });
  if (refund.needsInvestigation || !['APPROVED', 'FAILED'].includes(refund.status))
    throw financialConflict(
      'REFUND_REQUIRES_INVESTIGATION',
      'Only approved refunds or confirmed provider failures may be initiated. Unknown outcomes must be reconciled.',
    );
  await startRefund(request.params.refundId as string);
  sendSuccess(response, 202, 'Refund retry started', null);
};
