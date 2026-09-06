import { Router } from 'express';

import { UserRole } from '../../generated/prisma/client.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';

import { addOrder, cancelManagedOrder, readOrder, readOrders } from './orders.controller.js';
import { createOrderSchema, orderIdParamsSchema, orderListQuerySchema } from './orders.schemas.js';

const ordersRouter = Router();
ordersRouter.use(authenticate, authorize(UserRole.ATTENDEE));
ordersRouter.post('/', validate({ body: createOrderSchema }), addOrder);
ordersRouter.get('/', validate({ query: orderListQuerySchema }), readOrders);
ordersRouter.get('/:orderId', validate({ params: orderIdParamsSchema }), readOrder);
ordersRouter.post(
  '/:orderId/cancel',
  validate({ params: orderIdParamsSchema }),
  cancelManagedOrder,
);

export { ordersRouter };
