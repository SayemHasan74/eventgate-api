import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';

import { AppError } from '../shared/errors/app-error.js';
import type { ErrorDetail } from '../shared/responses/api-response.js';

type RequestPart = 'body' | 'params' | 'query';

export type RequestSchemas = Partial<Record<RequestPart, ZodType>>;

const toErrorDetails = (
  part: RequestPart,
  issues: { path: PropertyKey[]; message: string }[],
): ErrorDetail[] =>
  issues.map((issue) => ({
    field: [part, ...issue.path.map(String)].join('.'),
    code: 'INVALID_VALUE',
    message: issue.message,
  }));

export const validate =
  (schemas: RequestSchemas) =>
  async (request: Request, _response: Response, next: NextFunction): Promise<void> => {
    const errors: ErrorDetail[] = [];

    for (const part of ['body', 'params', 'query'] as const) {
      const schema = schemas[part];
      if (!schema) {
        continue;
      }

      const result = await schema.safeParseAsync(request[part]);
      if (!result.success) {
        errors.push(...toErrorDetails(part, result.error.issues));
        continue;
      }

      // Express 5 exposes `request.query` through a getter without a setter.
      // Define the validated value explicitly so parsed defaults reach controllers
      // without mutating the framework's read-only property directly.
      Object.defineProperty(request, part, {
        value: result.data,
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }

    if (errors.length > 0) {
      next(
        new AppError({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          message: 'Validation failed',
          errors,
        }),
      );
      return;
    }

    next();
  };
