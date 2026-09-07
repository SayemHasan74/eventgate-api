import { Router } from 'express';
import { UserRole } from '../../generated/prisma/client.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import {
  createRefundRequest,
  readRefunds,
  retryRefund,
  reviewRefundRequest,
} from './refunds.controller.js';
import {
  orderIdParamsSchema,
  refundIdParamsSchema,
  reviewRefundSchema,
} from './refunds.schemas.js';

const attendeeRefundsRouter = Router();
attendeeRefundsRouter.post(
  '/orders/:orderId/refund-requests',
  authenticate,
  authorize(UserRole.ATTENDEE),
  validate({ params: orderIdParamsSchema }),
  createRefundRequest,
);
attendeeRefundsRouter.get(
  '/refund-requests',
  authenticate,
  authorize(UserRole.ATTENDEE),
  readRefunds,
);
const adminRefundsRouter = Router();
adminRefundsRouter.use(authenticate, authorize(UserRole.ADMIN));
adminRefundsRouter.get('/refunds', readRefunds);
adminRefundsRouter.patch(
  '/refunds/:refundId',
  validate({ params: refundIdParamsSchema, body: reviewRefundSchema }),
  reviewRefundRequest,
);
adminRefundsRouter.post(
  '/refunds/:refundId/retry',
  validate({ params: refundIdParamsSchema }),
  retryRefund,
);
export { adminRefundsRouter, attendeeRefundsRouter };
