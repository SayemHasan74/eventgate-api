import type { UserRole } from '../generated/prisma/client.js';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth: {
        id: string;
        email: string;
        displayName: string;
        role: UserRole;
      };
    }
  }
}

export {};
