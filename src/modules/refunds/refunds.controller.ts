import type { RequestHandler } from 'express';
import { paginationQuerySchema, paginationMeta } from '../../shared/responses/pagination.js';
import { sendList, sendSuccess } from '../../shared/responses/api-response.js';
import { listRefunds, requestRefund, reviewRefund, startRefund } from './refunds.service.js';
import { getPrisma } from '../../lib/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import { financialConflict } from './capture-refund.js';

export const createRefundRequest: RequestHandler = async (request, response) =>
  sendSuccess(
    response,
    201,
    'Refund requested',
    await requestRefund(
      request.auth.id,
      request.params.orderId as string,
      request.body?.userMessage,
    ),
  );
export const readRefunds: RequestHandler = async (request, response) => {
  const query = paginationQuerySchema.parse(request.query);
  const result = await listRefunds(request.auth, query);
  sendList(response, 'Refunds retrieved', result.refunds, paginationMeta(query, result.total));
};
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
