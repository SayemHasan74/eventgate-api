import argon2 from 'argon2';
import { z } from 'zod';
import { Prisma, type PrismaClient } from '../src/generated/prisma/client.js';

export class SeedSafetyError extends Error {}

export function assertSeedTarget(mode: string | undefined, databaseUrl: string) {
  if (mode !== 'development' && mode !== 'test')
    throw new SeedSafetyError(
      'db:seed requires NODE_ENV=development or test; production is forbidden.',
    );
  const url = new URL(databaseUrl);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw new SeedSafetyError(
      'db:seed accepts only a local PostgreSQL database; remote databases are forbidden.',
    );
}

const settingsSchema = z.object({
  SEED_ADMIN_EMAIL: z.email().transform((v) => v.toLowerCase()),
  SEED_ORGANIZER_EMAIL: z.email().transform((v) => v.toLowerCase()),
  SEED_ATTENDEE_EMAIL: z.email().transform((v) => v.toLowerCase()),
  SEED_ADMIN_PASSWORD: z.string().min(12).max(128),
  SEED_ORGANIZER_PASSWORD: z.string().min(12).max(128),
  SEED_ATTENDEE_PASSWORD: z.string().min(12).max(128),
});
export async function seedDevelopmentData(
  database: PrismaClient,
  settings: Record<string, unknown>,
  now = new Date(),
) {
  const parsed = settingsSchema.safeParse(settings);
  if (!parsed.success)
    throw new SeedSafetyError(
      'Provide three valid seed emails and passwords of 12–128 characters.',
    );
  const values = parsed.data;
  const accounts = [
    {
      email: values.SEED_ADMIN_EMAIL,
      password: values.SEED_ADMIN_PASSWORD,
      role: 'ADMIN' as const,
      displayName: 'EventGate Admin',
    },
    {
      email: values.SEED_ORGANIZER_EMAIL,
      password: values.SEED_ORGANIZER_PASSWORD,
      role: 'ORGANIZER' as const,
      displayName: 'EventGate Organizer',
    },
    {
      email: values.SEED_ATTENDEE_EMAIL,
      password: values.SEED_ATTENDEE_PASSWORD,
      role: 'ATTENDEE' as const,
      displayName: 'EventGate Attendee',
    },
  ];
  if (new Set(accounts.map((a) => a.email)).size !== accounts.length)
    throw new SeedSafetyError('The three seed accounts must have different email addresses.');
  return database.$transaction(
    async (tx) => {
      const users = [];
      for (const account of accounts) {
        let user = await tx.user.findUnique({ where: { email: account.email } });
        if (user && (user.role !== account.role || user.status !== 'ACTIVE' || user.deletedAt))
          throw new SeedSafetyError(
            'An existing seed account has a conflicting role or inactive status. No records were changed.',
          );
        if (!user)
          user = await tx.user.create({
            data: {
              email: account.email,
              displayName: account.displayName,
              role: account.role,
              passwordHash: await argon2.hash(account.password, { type: argon2.argon2id }),
            },
          });
        users.push(user);
      }
      const organizer = users.find((user) => user.role === 'ORGANIZER')!;
      const existing = await tx.event.findUnique({ where: { slug: 'eventgate-launch-demo' } });
      // An existing event owns its complete lifecycle and inventory. Even missing
      // tiers must not be silently recreated on a published or archived event.
      if (existing) return { accounts: users.length, eventCreated: false };
      const startAt = new Date(now.getTime() + 30 * 86400000);
      await tx.event.create({
        data: {
          organizerId: organizer.id,
          title: 'EventGate Launch Demo',
          slug: 'eventgate-launch-demo',
          description: 'A seeded draft event used to verify EventGate workflows.',
          category: 'Technology',
          venue: 'EventGate Demo Venue',
          city: 'Dhaka',
          address: 'Demo address, Dhaka, Bangladesh',
          startAt,
          endAt: new Date(startAt.getTime() + 4 * 3600000),
          ticketTiers: {
            create: [
              { name: 'General Admission', pricePaisa: 50000, capacity: 100 },
              { name: 'VIP', pricePaisa: 150000, capacity: 25 },
            ].map((tier) => ({
              ...tier,
              salesStartAt: now,
              salesEndAt: new Date(startAt.getTime() - 3600000),
            })),
          },
        },
      });
      return { accounts: users.length, eventCreated: true };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30000 },
  );
}
