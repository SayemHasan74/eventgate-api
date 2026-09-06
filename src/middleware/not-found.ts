import type { Request, Response } from 'express';

import { sendError } from '../shared/responses/api-response.js';

export const notFound = (request: Request, response: Response): void => {
  sendError(response, 404, 'Route not found', [
    {
      code: 'NOT_FOUND',
      message: `No route matches ${request.method} ${request.originalUrl}`,
    },
  ]);
};
