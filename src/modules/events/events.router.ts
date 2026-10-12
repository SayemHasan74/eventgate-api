import { Router } from 'express';

import { UserRole } from '../../generated/prisma/client.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { ticketTiersRouter } from '../ticket-tiers/ticket-tiers.router.js';
import { emptyQuerySchema, emptyCommandSchema } from '../../shared/responses/read-contracts.js';

import {
  addEvent,
  editEvent,
  publishManagedEvent,
  readManagedEvents,
  readManagedEvent,
  removeEvent,
  requestEventCancellation,
} from './events.controller.js';
import {
  createEventSchema,
  eventIdParamsSchema,
  updateEventSchema,
  managedEventQuerySchema,
} from './events.schemas.js';

const eventsRouter = Router();
eventsRouter.use(authenticate, authorize(UserRole.ORGANIZER, UserRole.ADMIN));
eventsRouter.get('/', validate({ query: managedEventQuerySchema }), readManagedEvents);
eventsRouter.get(
  '/:eventId',
  validate({ params: eventIdParamsSchema, query: emptyQuerySchema }),
  readManagedEvent,
);
eventsRouter.post('/', validate({ body: createEventSchema }), addEvent);
eventsRouter.patch(
  '/:eventId',
  validate({ params: eventIdParamsSchema, body: updateEventSchema }),
  editEvent,
);
eventsRouter.delete('/:eventId', validate({ params: eventIdParamsSchema }), removeEvent);
eventsRouter.post(
  '/:eventId/publish',
  validate({ params: eventIdParamsSchema, query: emptyQuerySchema, body: emptyCommandSchema }),
  publishManagedEvent,
);
eventsRouter.post(
  '/:eventId/cancel',
  validate({ params: eventIdParamsSchema, query: emptyQuerySchema, body: emptyCommandSchema }),
  requestEventCancellation,
);
eventsRouter.use(
  '/:eventId/ticket-tiers',
  validate({ params: eventIdParamsSchema }),
  ticketTiersRouter,
);

export { eventsRouter };
