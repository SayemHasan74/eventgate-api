import type { RequestHandler } from 'express';

import { sendList, sendSuccess } from '../../shared/responses/api-response.js';

import type { DiscoveryQuery } from './public-events.schemas.js';
import { discoverEvents, getPublicEvent } from './public-events.service.js';

export const readPublicEvents: RequestHandler = async (request, response) => {
  const isDemo = request.baseUrl.endsWith('/demo/events');
  const result = await discoverEvents(request.query as unknown as DiscoveryQuery, isDemo);
  sendList(response, 'Published events retrieved', result.events, result.meta);
};

export const readPublicEvent: RequestHandler = async (request, response) => {
  const isDemo = request.baseUrl.endsWith('/demo/events');
  sendSuccess(
    response,
    200,
    'Published event retrieved',
    await getPublicEvent(request.params.slug as string, isDemo),
  );
};
