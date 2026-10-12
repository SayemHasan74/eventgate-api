import { Router } from 'express';

import { validate } from '../../middleware/validate.js';

import { addTicketTier, editTicketTier, removeTicketTier } from './ticket-tiers.controller.js';
import {
  createTicketTierSchema,
  ticketTierIdParamsSchema,
  updateTicketTierSchema,
} from './ticket-tiers.schemas.js';

const ticketTiersRouter = Router({ mergeParams: true });
import { listManagedTiers } from './ticket-tiers.service.js';
import { sendList } from '../../shared/responses/api-response.js';
import { paginationMeta } from '../../shared/responses/pagination.js';
import { listFields } from '../../shared/responses/read-contracts.js';
import { z } from 'zod';
const querySchema = z.object({ page: listFields.page, limit: listFields.limit }).strict();
ticketTiersRouter.get('/', validate({ query: querySchema }), async (request, response) => {
  const query = querySchema.parse(request.query);
  const result = await listManagedTiers(request.auth, request.params.eventId as string, query);
  sendList(response, 'Ticket tiers retrieved', result.tiers, paginationMeta(query, result.total));
});

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
