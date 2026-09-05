import { PrismaPg } from '@prisma/adapter-pg';

import { env } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';

if (!env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required before Prisma can connect to EventGate.');
}

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

export const prisma = new PrismaClient({ adapter });
