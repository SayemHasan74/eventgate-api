import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

const isValidRequestId = (value: string | undefined): value is string =>
  Boolean(value && /^[A-Za-z0-9_-]{8,128}$/.test(value));

export const requestId = (request: Request, response: Response, next: NextFunction): void => {
  const receivedId = request.header('x-request-id');
  const id = isValidRequestId(receivedId) ? receivedId : randomUUID();

  request.requestId = id;
  response.setHeader('x-request-id', id);
  next();
};
