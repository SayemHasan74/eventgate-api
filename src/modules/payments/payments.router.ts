import { Router } from 'express';
import type { RequestHandler } from 'express';

import { UserRole } from '../../generated/prisma/client.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { AppError } from '../../shared/errors/app-error.js';

import { beginCheckout, receiveSslcommerzCallback } from './payments.controller.js';
import { paymentOrderIdParamsSchema } from './payments.schemas.js';

const paymentsRouter = Router();
paymentsRouter.use(authenticate, authorize(UserRole.ATTENDEE));
const requireIdempotencyKey: RequestHandler = (request, _response, next) => {
  const key = request.get('Idempotency-Key');
  if (key && key.trim().length <= 255) return next();
  next(
    new AppError({
      statusCode: 400,
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: 'Idempotency-Key header is required',
      errors: [
        {
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          message: 'Provide an Idempotency-Key up to 255 characters.',
        },
      ],
    }),
  );
};
paymentsRouter.post(
  '/orders/:orderId/checkout',
  requireIdempotencyKey,
  validate({ params: paymentOrderIdParamsSchema }),
  beginCheckout,
);

export { paymentsRouter };

const sslcommerzCallbacksRouter = Router();
sslcommerzCallbacksRouter.post('/ipn', receiveSslcommerzCallback('IPN'));
sslcommerzCallbacksRouter.post('/success', receiveSslcommerzCallback('SUCCESS'));
sslcommerzCallbacksRouter.post('/fail', receiveSslcommerzCallback('FAIL'));
sslcommerzCallbacksRouter.post('/cancel', receiveSslcommerzCallback('CANCEL'));

export { sslcommerzCallbacksRouter };
