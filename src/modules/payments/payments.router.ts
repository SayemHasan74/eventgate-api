import { Router } from 'express';

import { UserRole } from '../../generated/prisma/client.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';

import { beginCheckout } from './payments.controller.js';
import { paymentOrderIdParamsSchema } from './payments.schemas.js';

const paymentsRouter = Router();
paymentsRouter.use(authenticate, authorize(UserRole.ATTENDEE));
paymentsRouter.post(
  '/orders/:orderId/checkout',
  validate({ params: paymentOrderIdParamsSchema }),
  beginCheckout,
);

export { paymentsRouter };
