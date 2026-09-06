import { Router } from 'express';

import { UserRole } from '../../generated/prisma/client.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';

import {
  readCheckInHistory,
  readMyTicket,
  readMyTicketQr,
  readMyTickets,
  submitCheckIn,
} from './tickets.controller.js';
import {
  checkInHistoryQuerySchema,
  checkInSchema,
  eventIdParamsSchema,
  ticketIdParamsSchema,
} from './tickets.schemas.js';

const ticketsRouter = Router();
ticketsRouter.use(authenticate, authorize(UserRole.ATTENDEE));
ticketsRouter.get('/', readMyTickets);
ticketsRouter.get('/:ticketId', validate({ params: ticketIdParamsSchema }), readMyTicket);
ticketsRouter.get('/:ticketId/qr', validate({ params: ticketIdParamsSchema }), readMyTicketQr);

const checkInRouter = Router();
checkInRouter.use(authenticate, authorize(UserRole.ORGANIZER, UserRole.ADMIN));
checkInRouter.post(
  '/',
  validate({ params: eventIdParamsSchema, body: checkInSchema }),
  submitCheckIn,
);
checkInRouter.get(
  '/',
  validate({ params: eventIdParamsSchema, query: checkInHistoryQuerySchema }),
  readCheckInHistory,
);

export { checkInRouter, ticketsRouter };
