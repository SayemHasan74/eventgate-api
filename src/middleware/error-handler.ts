import type { ErrorRequestHandler } from 'express';

import { logger } from '../lib/logger.js';
import { isAppError } from '../shared/errors/app-error.js';
import { sendError } from '../shared/responses/api-response.js';

export const errorHandler: ErrorRequestHandler = (error, request, response, next) => {
  void next;
  const requestLogger = request.log ?? logger;

  if (isAppError(error)) {
    requestLogger.warn(
      { err: error, requestId: request.requestId, code: error.code },
      error.message,
    );
    sendError(response, error.statusCode, error.message, error.errors);
    return;
  }

  if (error instanceof SyntaxError && 'body' in error) {
    requestLogger.warn({ err: error, requestId: request.requestId }, 'Malformed JSON request body');
    sendError(response, 400, 'Malformed JSON request body', [
      { code: 'INVALID_JSON', message: 'Request body must contain valid JSON.' },
    ]);
    return;
  }

  requestLogger.error({ err: error, requestId: request.requestId }, 'Unhandled application error');
  sendError(response, 500, 'Internal server error', [
    { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
  ]);
};
