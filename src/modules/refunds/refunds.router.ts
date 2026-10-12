import { Router } from 'express';
import { UserRole } from '../../generated/prisma/client.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { emptyQuerySchema } from '../../shared/responses/read-contracts.js';
import {
  adminReasonSchema,
  scheduleAdminReconciliation,
} from '../reports/admin-operations.service.js';
import { sendSuccess } from '../../shared/responses/api-response.js';
import {
  createRefundRequest,
  readRefunds,
  readRefund,
  retryRefund,
  reviewRefundRequest,
} from './refunds.controller.js';
import {
  orderIdParamsSchema,
  refundIdParamsSchema,
  reviewRefundSchema,
  requestRefundSchema,
  refundListQuerySchema,
} from './refunds.schemas.js';

const attendeeRefundsRouter = Router();
attendeeRefundsRouter.post(
  '/orders/:orderId/refund-requests',
  authenticate,
  authorize(UserRole.ATTENDEE),
  validate({ params: orderIdParamsSchema, body: requestRefundSchema }),
  createRefundRequest,
);
attendeeRefundsRouter.get(
  '/refund-requests',
  authenticate,
  authorize(UserRole.ATTENDEE),
  validate({ query: refundListQuerySchema }),
  readRefunds,
);
attendeeRefundsRouter.get(
  '/refund-requests/:refundId',
  authenticate,
  authorize(UserRole.ATTENDEE),
  validate({ params: refundIdParamsSchema, query: emptyQuerySchema }),
  readRefund,
);
const adminRefundsRouter = Router();
adminRefundsRouter.use(authenticate, authorize(UserRole.ADMIN));
adminRefundsRouter.get('/refunds', validate({ query: refundListQuerySchema }), readRefunds);
adminRefundsRouter.get(
  '/refunds/:refundId',
  validate({ params: refundIdParamsSchema, query: emptyQuerySchema }),
  readRefund,
);
adminRefundsRouter.patch(
  '/refunds/:refundId',
  validate({ params: refundIdParamsSchema, body: reviewRefundSchema }),
  reviewRefundRequest,
);
adminRefundsRouter.post(
  '/refunds/:refundId/retry',
  validate({ params: refundIdParamsSchema, query: emptyQuerySchema, body: adminReasonSchema }),
  retryRefund,
);
adminRefundsRouter.post(
  '/refunds/:refundId/reconcile',
  validate({ params: refundIdParamsSchema, query: emptyQuerySchema, body: adminReasonSchema }),
  async (request, response) =>
    sendSuccess(
      response,
      202,
      'Refund verification scheduled, not settlement',
      await scheduleAdminReconciliation(
        request.auth.id,
        'refund',
        request.params.refundId as string,
        request.body.reason,
      ),
    ),
);
export { adminRefundsRouter, attendeeRefundsRouter };
