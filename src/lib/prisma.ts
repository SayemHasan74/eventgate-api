import { PrismaPg } from '@prisma/adapter-pg';

import { env } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';

let prisma: PrismaClient | undefined;

export const getPrisma = (): PrismaClient => {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required before Prisma can connect to EventGate.');
  }

  if (!prisma) {
    const adapter = new PrismaPg({
      connectionString: env.DATABASE_URL,
      // Keep a small working set between actions instead of repeating TLS/auth
      // handshakes after pg's default ten-second idle timeout.
      min: 2,
      max: env.DATABASE_POOL_MAX,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 12_000,
      idleTimeoutMillis: 60_000,
      keepAlive: true,
    });
    prisma = new PrismaClient({ adapter });
  }

  return prisma;
};
