import type { NextFunction, Request, Response } from 'express';

import { UserStatus } from '../generated/prisma/client.js';
import { getPrisma } from '../lib/prisma.js';
import { verifyAccessToken } from '../modules/auth/token.service.js';
import { AppError } from '../shared/errors/app-error.js';

export const authenticate = async (
  request: Request,
  _response: Response,
  next: NextFunction,
): Promise<void> => {
  const authorization = request.header('authorization');
  const match = authorization?.match(/^Bearer\s+(.+)$/iu);

  if (!match?.[1]) {
    next(
      new AppError({
        statusCode: 401,
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication is required',
        errors: [{ code: 'AUTHENTICATION_REQUIRED', message: 'Provide a Bearer access token.' }],
      }),
    );
    return;
  }

  const claims = await verifyAccessToken(match[1]);
  const user = await getPrisma().user.findUnique({
    where: { id: claims.userId },
    select: { id: true, email: true, displayName: true, role: true, status: true, deletedAt: true },
  });

  if (!user || user.status !== UserStatus.ACTIVE || user.deletedAt) {
    next(
      new AppError({
        statusCode: 401,
        code: 'ACCOUNT_INACTIVE',
        message: 'Account is not active',
        errors: [
          { code: 'ACCOUNT_INACTIVE', message: 'This account cannot access protected routes.' },
        ],
      }),
    );
    return;
  }

  request.auth = { id: user.id, email: user.email, displayName: user.displayName, role: user.role };
  next();
};
