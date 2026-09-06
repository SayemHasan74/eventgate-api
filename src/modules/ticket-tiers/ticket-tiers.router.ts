import { Router } from 'express';

import { validate } from '../../middleware/validate.js';

import { addTicketTier, editTicketTier, removeTicketTier } from './ticket-tiers.controller.js';
import {
  createTicketTierSchema,
  ticketTierIdParamsSchema,
  updateTicketTierSchema,
} from './ticket-tiers.schemas.js';

const ticketTiersRouter = Router({ mergeParams: true });

ticketTiersRouter.post('/', validate({ body: createTicketTierSchema }), addTicketTier);
ticketTiersRouter.patch(
  '/:tierId',
  validate({ params: ticketTierIdParamsSchema, body: updateTicketTierSchema }),
  editTicketTier,
);
ticketTiersRouter.delete(
  '/:tierId',
  validate({ params: ticketTierIdParamsSchema }),
  removeTicketTier,
);

export { ticketTiersRouter };
