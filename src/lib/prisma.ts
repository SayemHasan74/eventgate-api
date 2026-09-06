import { PrismaPg } from '@prisma/adapter-pg';

import { env } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';

let prisma: PrismaClient | undefined;

export const getPrisma = (): PrismaClient => {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required before Prisma can connect to EventGate.');
  }

  if (!prisma) {
    const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
    prisma = new PrismaClient({ adapter });
  }

  return prisma;
};
