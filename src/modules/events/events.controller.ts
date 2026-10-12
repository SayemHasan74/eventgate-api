import type { RequestHandler } from 'express';
import { paginationMeta } from '../../shared/responses/pagination.js';
import { managedEventQuerySchema } from './events.schemas.js';

import { sendList, sendSuccess } from '../../shared/responses/api-response.js';

import type { CreateEventInput, UpdateEventInput } from './events.schemas.js';
import {
  cancelEvent,
  createEvent,
  listManagedEvents,
  getManagedEvent,
  publishEvent,
  softDeleteEvent,
  updateEvent,
} from './events.service.js';

export const readManagedEvents: RequestHandler = async (request, response) => {
  const query = managedEventQuerySchema.parse(request.query);
  const result = await listManagedEvents(request.auth, query);
  sendList(
    response,
    'Organizer events retrieved',
    result.events,
    paginationMeta(query, result.total),
    result.summary,
  );
};
export const readManagedEvent: RequestHandler = async (request, response) =>
  sendSuccess(
    response,
    200,
    'Event retrieved',
    await getManagedEvent(request.auth, request.params.eventId as string),
  );

export const addEvent: RequestHandler = async (request, response) => {
  sendSuccess(
    response,
    201,
    'Event created',
    await createEvent(request.auth.id, request.body as CreateEventInput),
  );
};

export const editEvent: RequestHandler = async (request, response) => {
  sendSuccess(
    response,
    200,
    'Event updated',
    await updateEvent(
      request.auth,
      request.params.eventId as string,
      request.body as UpdateEventInput,
    ),
  );
};

export const removeEvent: RequestHandler = async (request, response) => {
  await softDeleteEvent(request.auth, request.params.eventId as string);
  sendSuccess(response, 200, 'Event deleted', null);
};

export const publishManagedEvent: RequestHandler = async (request, response) => {
  sendSuccess(
    response,
    200,
    'Event published',
    await publishEvent(request.auth, request.params.eventId as string),
  );
};

export const requestEventCancellation: RequestHandler = async (request, response) => {
  sendSuccess(
    response,
    200,
    'Event cancellation scheduled',
    await cancelEvent(request.auth, request.params.eventId as string),
  );
};
