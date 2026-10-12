import { Router } from 'express';

import { UserRole } from '../../generated/prisma/client.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { emptyQuerySchema } from '../../shared/responses/read-contracts.js';

import {
  readCheckInHistory,
  readMyTicket,
  readMyTicketQr,
  readMyTickets,
  readMyBookings,
  submitCheckIn,
} from './tickets.controller.js';
import {
  checkInHistoryQuerySchema,
  checkInSchema,
  eventIdParamsSchema,
  ticketIdParamsSchema,
  ticketListQuerySchema,
} from './tickets.schemas.js';

const ticketsRouter = Router();
ticketsRouter.use((_request, response, next) => {
  response.setHeader('Cache-Control', 'private, no-store');
  next();
});
ticketsRouter.use(authenticate, authorize(UserRole.ATTENDEE));
ticketsRouter.get('/', validate({ query: ticketListQuerySchema }), readMyTickets);
ticketsRouter.get('/bookings', validate({ query: ticketListQuerySchema }), readMyBookings);
ticketsRouter.get(
  '/:ticketId',
  validate({ params: ticketIdParamsSchema, query: emptyQuerySchema }),
  readMyTicket,
);
ticketsRouter.get(
  '/:ticketId/qr',
  validate({ params: ticketIdParamsSchema, query: emptyQuerySchema }),
  readMyTicketQr,
);

const checkInRouter = Router({ mergeParams: true });
checkInRouter.use((_request, response, next) => {
  response.setHeader('Cache-Control', 'private, no-store');
  next();
});
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
