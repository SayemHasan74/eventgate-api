import type { RequestHandler } from 'express';
import { paginationMeta } from '../../shared/responses/pagination.js';
import { ticketListQuerySchema } from './tickets.schemas.js';

import { sendList, sendSuccess } from '../../shared/responses/api-response.js';

import {
  checkInTicket,
  getMyTicket,
  getMyTicketQr,
  listCheckInHistory,
  listMyTickets,
  listMyBookings,
} from './tickets.service.js';
import type { CheckInHistoryQuery } from './tickets.schemas.js';

export const readMyTickets: RequestHandler = async (request, response) => {
  const query = ticketListQuerySchema.parse(request.query);
  const result = await listMyTickets(request.auth.id, query);
  sendList(response, 'Tickets retrieved', result.tickets, paginationMeta(query, result.total));
};
export const readMyBookings: RequestHandler = async (request, response) => {
  const query = ticketListQuerySchema.parse(request.query);
  const result = await listMyBookings(request.auth.id, query);
  sendList(
    response,
    'Ticket bookings retrieved',
    result.bookings,
    paginationMeta(query, result.total),
  );
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
  sendSuccess(
    response,
    200,
    'Ticket QR retrieved',
    await getMyTicketQr(request.auth.id, request.params.ticketId as string),
  );
};

export const submitCheckIn: RequestHandler = async (request, response) => {
  sendSuccess(
    response,
    200,
    'Check-in evaluated',
    await checkInTicket(request.auth, request.params.eventId as string, request.body),
  );
};

export const readCheckInHistory: RequestHandler = async (request, response) => {
  const result = await listCheckInHistory(
    request.auth,
    request.params.eventId as string,
    request.query as unknown as CheckInHistoryQuery,
  );
  sendList(
    response,
    'Check-in history retrieved',
    result.tickets,
    {
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: Math.ceil(result.total / result.limit),
    },
    { checkedInCount: result.checkedInCount },
  );
};
