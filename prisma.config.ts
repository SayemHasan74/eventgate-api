import 'dotenv/config';

import { defineConfig, env } from 'prisma/config';

const migrationConnection = new URL(process.env.DIRECT_URL || env('DATABASE_URL'));
if (!process.env.DIRECT_URL && migrationConnection.hostname.endsWith('.neon.tech')) {
  migrationConnection.hostname = migrationConnection.hostname.replace(/-pooler(?=\.)/, '');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Advisory locks require a persistent session, not Neon's transaction pooler.
    url: migrationConnection.toString(),
  },
});
