import type { RequestHandler } from 'express';

import { sendSuccess } from '../../shared/responses/api-response.js';

import type { CreateEventInput, UpdateEventInput } from './events.schemas.js';
import {
  cancelEvent,
  createEvent,
  listManagedEvents,
  publishEvent,
  softDeleteEvent,
  updateEvent,
} from './events.service.js';

export const readManagedEvents: RequestHandler = async (request, response) => {
  sendSuccess(response, 200, 'Organizer events retrieved', await listManagedEvents(request.auth));
};

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
