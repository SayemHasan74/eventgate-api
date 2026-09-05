import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';
import argon2 from 'argon2';

import { EventStatus, PrismaClient, UserRole, UserStatus } from '../src/generated/prisma/client.js';

const requiredSeedValue = (name: string): string => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required to seed EventGate.`);
  }

  return value;
};

const databaseUrl = requiredSeedValue('DATABASE_URL');
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});

const createPasswordHash = async (name: string): Promise<string> =>
  argon2.hash(requiredSeedValue(name), { type: argon2.argon2id });

const main = async (): Promise<void> => {
  const [adminPasswordHash, organizerPasswordHash, attendeePasswordHash] = await Promise.all([
    createPasswordHash('SEED_ADMIN_PASSWORD'),
    createPasswordHash('SEED_ORGANIZER_PASSWORD'),
    createPasswordHash('SEED_ATTENDEE_PASSWORD'),
  ]);

  const admin = await prisma.user.upsert({
    where: { email: requiredSeedValue('SEED_ADMIN_EMAIL').trim().toLowerCase() },
    update: {
      displayName: 'EventGate Admin',
      passwordHash: adminPasswordHash,
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
      deletedAt: null,
    },
    create: {
      email: requiredSeedValue('SEED_ADMIN_EMAIL').trim().toLowerCase(),
      displayName: 'EventGate Admin',
      passwordHash: adminPasswordHash,
      role: UserRole.ADMIN,
    },
  });

  const organizer = await prisma.user.upsert({
    where: { email: requiredSeedValue('SEED_ORGANIZER_EMAIL').trim().toLowerCase() },
    update: {
      displayName: 'EventGate Organizer',
      passwordHash: organizerPasswordHash,
      role: UserRole.ORGANIZER,
      status: UserStatus.ACTIVE,
      deletedAt: null,
    },
    create: {
      email: requiredSeedValue('SEED_ORGANIZER_EMAIL').trim().toLowerCase(),
      displayName: 'EventGate Organizer',
      passwordHash: organizerPasswordHash,
      role: UserRole.ORGANIZER,
    },
  });

  const attendee = await prisma.user.upsert({
    where: { email: requiredSeedValue('SEED_ATTENDEE_EMAIL').trim().toLowerCase() },
    update: {
      displayName: 'EventGate Attendee',
      passwordHash: attendeePasswordHash,
      role: UserRole.ATTENDEE,
      status: UserStatus.ACTIVE,
      deletedAt: null,
    },
    create: {
      email: requiredSeedValue('SEED_ATTENDEE_EMAIL').trim().toLowerCase(),
      displayName: 'EventGate Attendee',
      passwordHash: attendeePasswordHash,
      role: UserRole.ATTENDEE,
    },
  });

  const currentTime = new Date();
  const eventStart = new Date(currentTime.getTime() + 30 * 24 * 60 * 60 * 1000);
  const eventEnd = new Date(eventStart.getTime() + 4 * 60 * 60 * 1000);
  const salesEnd = new Date(eventStart.getTime() - 60 * 60 * 1000);

  const event = await prisma.event.upsert({
    where: { slug: 'eventgate-launch-demo' },
    update: {
      organizerId: organizer.id,
      title: 'EventGate Launch Demo',
      description: 'A seeded draft event used to verify EventGate workflows.',
      category: 'Technology',
      venue: 'EventGate Demo Venue',
      city: 'Dhaka',
      address: 'Demo address, Dhaka, Bangladesh',
      startAt: eventStart,
      endAt: eventEnd,
      status: EventStatus.DRAFT,
      deletedAt: null,
    },
    create: {
      organizerId: organizer.id,
      title: 'EventGate Launch Demo',
      slug: 'eventgate-launch-demo',
      description: 'A seeded draft event used to verify EventGate workflows.',
      category: 'Technology',
      venue: 'EventGate Demo Venue',
      city: 'Dhaka',
      address: 'Demo address, Dhaka, Bangladesh',
      startAt: eventStart,
      endAt: eventEnd,
    },
  });

  await prisma.ticketTier.upsert({
    where: {
      eventId_name: {
        eventId: event.id,
        name: 'General Admission',
      },
    },
    update: {
      pricePaisa: 50000,
      capacity: 100,
      salesStartAt: currentTime,
      salesEndAt: salesEnd,
      deletedAt: null,
    },
    create: {
      eventId: event.id,
      name: 'General Admission',
      pricePaisa: 50000,
      capacity: 100,
      salesStartAt: currentTime,
      salesEndAt: salesEnd,
    },
  });

  await prisma.ticketTier.upsert({
    where: {
      eventId_name: {
        eventId: event.id,
        name: 'VIP',
      },
    },
    update: {
      pricePaisa: 150000,
      capacity: 25,
      salesStartAt: currentTime,
      salesEndAt: salesEnd,
      deletedAt: null,
    },
    create: {
      eventId: event.id,
      name: 'VIP',
      pricePaisa: 150000,
      capacity: 25,
      salesStartAt: currentTime,
      salesEndAt: salesEnd,
    },
  });

  console.info(
    `Seeded admin ${admin.email}, organizer ${organizer.email}, and attendee ${attendee.email}.`,
  );
};

main()
  .catch((error: unknown) => {
    console.error('EventGate seed failed.', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
