import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import argon2 from 'argon2';
import { PrismaClient, UserRole, UserStatus, EventStatus } from '../src/generated/prisma/client.js';

const required = (key: string) => {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is required to provision recruiter demo access.`);
  return value;
};

const demoPassword = (key: string) => {
  const value = required(key);
  if (value.length < 12) throw new Error(`${key} must be at least 12 characters.`);
  return value;
};

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: required('DATABASE_URL') }) });

async function demoUser(role: UserRole.ATTENDEE | UserRole.ORGANIZER, prefix: 'DEMO_ATTENDEE' | 'DEMO_ORGANIZER') {
  const email = required(`${prefix}_EMAIL`).toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (!existing.isDemo || existing.role !== role || existing.status !== UserStatus.ACTIVE || existing.deletedAt)
      throw new Error(`${email} already exists but is not an active ${role} demo identity; refusing to convert or overwrite it.`);
    return existing;
  }
  const passwordHash = await argon2.hash(demoPassword(`${prefix}_PASSWORD`), { type: argon2.argon2id });
  return prisma.user.create({ data: {
    email,
    displayName: role === UserRole.ATTENDEE ? 'Demo Attendee' : 'Demo Organizer',
    passwordHash,
    role,
    isDemo: true,
    ...(role === UserRole.ATTENDEE ? { phone: '01700000000', address: 'Sandbox address, Dhaka', city: 'Dhaka', postalCode: '1200', country: 'Bangladesh' } : {}),
  } });
}

async function ensureSampleEvent(organizerId: string, sample: { slug: string; title: string; category: string; venue: string; description: string }, index: number) {
  const now = new Date();
  const startAt = new Date(now.getTime() + (35 + index * 12) * 86400000);
  startAt.setUTCHours(11 + index, 0, 0, 0);
  const endAt = new Date(startAt.getTime() + 3 * 3600000);
  let slug = `${sample.slug}-${now.toISOString().slice(0, 10).replaceAll('-', '')}`;
  let event = await prisma.event.findUnique({ where: { slug } });
  if (!event && await prisma.event.findUnique({ where: { slug: sample.slug } })) {
    slug = `${slug}-${now.getTime().toString().slice(-5)}`;
    event = await prisma.event.findUnique({ where: { slug } });
  }
  if (event) {
    if (!event.isDemo || event.organizerId !== organizerId)
      throw new Error(`Sample slug ${slug} belongs to a non-demo or different organizer event; refusing to modify it.`);
    if (event.startAt > now && event.status === EventStatus.PUBLISHED && !event.deletedAt) return event;
    return null;
  }
  const created = await prisma.event.create({ data: {
    organizerId,
    isDemo: true,
    title: sample.title,
    slug,
    description: `${sample.description} Sample event for recruiter demo exploration; no real event or payment is represented.`,
    category: sample.category,
    venue: sample.venue,
    city: 'Dhaka',
    address: 'Sandbox venue, Dhaka, Bangladesh',
    startAt,
    endAt,
    status: EventStatus.PUBLISHED,
    publishedAt: now,
  } });
  for (const tier of [
    { name: 'General Admission', pricePaisa: 10000, capacity: 80 },
    { name: 'Priority Entry', pricePaisa: 25000, capacity: 20 },
  ]) await prisma.ticketTier.create({ data: {
    eventId: created.id,
    ...tier,
    salesStartAt: now,
    salesEndAt: new Date(startAt.getTime() - 3600000),
  } });
  return created;
}

async function main() {
  const attendee = await demoUser(UserRole.ATTENDEE, 'DEMO_ATTENDEE');
  const organizer = await demoUser(UserRole.ORGANIZER, 'DEMO_ORGANIZER');
  const existingUpcoming = await prisma.event.count({ where: { organizerId: organizer.id, isDemo: true, deletedAt: null, startAt: { gt: new Date() }, status: { in: ['DRAFT', 'PUBLISHED'] } } });
  if (existingUpcoming > 10) throw new Error('Demo organizer already exceeds the 10-event safety limit.');
  const samples = [
    { slug: 'recruiter-demo-design-summit', title: 'Design Futures Summit', category: 'Technology', venue: 'Innovation Hall', description: 'A one-day gathering for product designers and creative technologists.' },
    { slug: 'recruiter-demo-live-sessions', title: 'Live Sessions: Dhaka', category: 'Music', venue: 'Riverfront Stage', description: 'An intimate evening of live music and local artists.' },
  ];
  let created = 0;
  for (let index = 0; index < samples.length && existingUpcoming + created < 10; index += 1)
    if (await ensureSampleEvent(organizer.id, samples[index]!, index)) created += 1;
  console.info(`Recruiter demo identities ready: ${attendee.email}, ${organizer.email}; ${created} future sample event(s) created.`);
}

main().catch((error: unknown) => {
  console.error('Demo provisioning refused or failed.', error);
  process.exitCode = 1;
}).finally(async () => prisma.$disconnect());
