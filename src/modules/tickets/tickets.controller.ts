import type { RequestHandler } from 'express';

import { sendList, sendSuccess } from '../../shared/responses/api-response.js';

import {
  checkInTicket,
  getMyTicket,
  getMyTicketQrSvg,
  listCheckInHistory,
  listMyTickets,
} from './tickets.service.js';
import type { CheckInHistoryQuery } from './tickets.schemas.js';

export const readMyTickets: RequestHandler = async (request, response) => {
  sendSuccess(response, 200, 'Tickets retrieved', await listMyTickets(request.auth.id));
};

export const readMyTicket: RequestHandler = async (request, response) => {
  sendSuccess(
    response,
    200,
    'Ticket retrieved',
    await getMyTicket(request.auth.id, request.params.ticketId as string),
  );
};

export const readMyTicketQr: RequestHandler = async (request, response) => {
  response.setHeader('Cache-Control', 'private, no-store');
  response
    .type('image/svg+xml')
    .send(await getMyTicketQrSvg(request.auth.id, request.params.ticketId as string));
};

export const submitCheckIn: RequestHandler = async (request, response) => {
  sendSuccess(
    response,
    200,
    'Ticket checked in',
    await checkInTicket(request.auth, request.params.eventId as string, request.body),
  );
};

export const readCheckInHistory: RequestHandler = async (request, response) => {
  const result = await listCheckInHistory(
    request.auth,
    request.params.eventId as string,
    request.query as unknown as CheckInHistoryQuery,
  );
  sendList(response, 'Check-in history retrieved', result.tickets, {
    page: result.page,
    limit: result.limit,
    total: result.total,
    totalPages: Math.ceil(result.total / result.limit),
  });
};
