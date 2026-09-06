import { Router } from 'express';

import { UserRole } from '../../generated/prisma/client.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { ticketTiersRouter } from '../ticket-tiers/ticket-tiers.router.js';

import {
  addEvent,
  editEvent,
  publishManagedEvent,
  readManagedEvents,
  removeEvent,
  requestEventCancellation,
} from './events.controller.js';
import { createEventSchema, eventIdParamsSchema, updateEventSchema } from './events.schemas.js';

const eventsRouter = Router();
eventsRouter.use(authenticate, authorize(UserRole.ORGANIZER, UserRole.ADMIN));
eventsRouter.get('/', readManagedEvents);
eventsRouter.post('/', validate({ body: createEventSchema }), addEvent);
eventsRouter.patch(
  '/:eventId',
  validate({ params: eventIdParamsSchema, body: updateEventSchema }),
  editEvent,
);
eventsRouter.delete('/:eventId', validate({ params: eventIdParamsSchema }), removeEvent);
eventsRouter.post(
  '/:eventId/publish',
  validate({ params: eventIdParamsSchema }),
  publishManagedEvent,
);
eventsRouter.post(
  '/:eventId/cancel',
  validate({ params: eventIdParamsSchema }),
  requestEventCancellation,
);
eventsRouter.use(
  '/:eventId/ticket-tiers',
  validate({ params: eventIdParamsSchema }),
  ticketTiersRouter,
);

export { eventsRouter };
