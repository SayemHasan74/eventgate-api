import { Prisma } from '../generated/prisma/client.js';
import { getPrisma } from './prisma.js';

export const isSerializationConflict = (error: unknown): boolean => {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2034') return true;
  if (error.code !== 'P2010') return false;
  // Prisma's PostgreSQL driver adapter wraps raw-query SQLSTATEs here.
  const adapter = error.meta?.driverAdapterError as
    { cause?: { originalCode?: string } } | undefined;
  return error.meta?.code === '40001' || adapter?.cause?.originalCode === '40001';
};

// Retry database serialization conflicts only. External calls must stay outside
// this callback because they cannot be rolled back with the transaction.
export const serializableTransaction = async <T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { timeout?: number } = {},
): Promise<T> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await getPrisma().$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 30_000,
        ...options,
      });
    } catch (error) {
      if (attempt >= 2 || !isSerializationConflict(error)) {
        throw error;
      }
    }
  }
};
