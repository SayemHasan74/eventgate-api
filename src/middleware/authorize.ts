import type { NextFunction, Request, Response } from 'express';

import type { UserRole } from '../generated/prisma/client.js';
import { AppError } from '../shared/errors/app-error.js';

export const authorize =
  (...roles: UserRole[]) =>
  (request: Request, _response: Response, next: NextFunction): void => {
    if (!roles.includes(request.auth.role)) {
      next(
        new AppError({
          statusCode: 403,
          code: 'FORBIDDEN',
          message: 'You do not have permission for this action',
          errors: [{ code: 'FORBIDDEN', message: 'Your role cannot access this resource.' }],
        }),
      );
      return;
    }
    next();
  };
