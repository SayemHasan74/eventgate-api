import { Prisma } from '../generated/prisma/client.js';
import { getPrisma } from './prisma.js';

// Retry database serialization conflicts only. External calls must stay outside
// this callback because they cannot be rolled back with the transaction.
export const serializableTransaction = async <T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await getPrisma().$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (
        attempt >= 2 ||
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== 'P2034'
      ) {
        throw error;
      }
    }
  }
};
