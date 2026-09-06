import type { RequestHandler } from 'express';

import { sendSuccess } from '../../shared/responses/api-response.js';

import type { CreateTicketTierInput, UpdateTicketTierInput } from './ticket-tiers.schemas.js';
import {
  createTicketTier,
  softDeleteTicketTier,
  updateTicketTier,
} from './ticket-tiers.service.js';

export const addTicketTier: RequestHandler = async (request, response) => {
  sendSuccess(
    response,
    201,
    'Ticket tier created',
    await createTicketTier(
      request.auth,
      request.params.eventId as string,
      request.body as CreateTicketTierInput,
    ),
  );
};

export const editTicketTier: RequestHandler = async (request, response) => {
  sendSuccess(
    response,
    200,
    'Ticket tier updated',
    await updateTicketTier(
      request.auth,
      request.params.eventId as string,
      request.params.tierId as string,
      request.body as UpdateTicketTierInput,
    ),
  );
};

export const removeTicketTier: RequestHandler = async (request, response) => {
  await softDeleteTicketTier(
    request.auth,
    request.params.eventId as string,
    request.params.tierId as string,
  );
  sendSuccess(response, 200, 'Ticket tier deleted', null);
};
