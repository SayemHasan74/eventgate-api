import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { assertSeedTarget, seedDevelopmentData, SeedSafetyError } from './seed-data.js';

let database: PrismaClient | undefined;
try {
  const url = process.env.DATABASE_URL;
  if (!url) throw new SeedSafetyError('DATABASE_URL is required.');
  assertSeedTarget(process.env.NODE_ENV, url);
  database = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  const result = await seedDevelopmentData(database, process.env);
  console.info(
    `Seed finished: ${result.accounts} accounts reused or created; sample event ${result.eventCreated ? 'created' : 'preserved'}. Existing records were not reset.`,
  );
} catch (error) {
  console.error(
    error instanceof SeedSafetyError
      ? error.message
      : 'Database seed failed. Existing records were not reset.',
  );
  process.exitCode = 1;
} finally {
  await database?.$disconnect();
}
