import { EventStatus, type Prisma } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';

import { readDiscoveryCache, writeDiscoveryCache } from './public-events.cache.js';
import type { DiscoveryQuery } from './public-events.schemas.js';

const publicTierSelect = {
  id: true,
  name: true,
  pricePaisa: true,
  capacity: true,
  reservedQuantity: true,
  soldQuantity: true,
  salesStartAt: true,
  salesEndAt: true,
} satisfies Prisma.TicketTierSelect;

const cacheKey = (name: string, value: unknown): string =>
  `${name}:${Buffer.from(JSON.stringify(value)).toString('base64url')}`;

const addAvailability = <
  T extends { ticketTiers: { capacity: number; reservedQuantity: number; soldQuantity: number }[] },
>(
  event: T,
) => ({
  ...event,
  ticketTiers: event.ticketTiers.map(({ capacity, reservedQuantity, soldQuantity, ...tier }) => ({
    ...tier,
    capacity,
    availableQuantity: capacity - reservedQuantity - soldQuantity,
  })),
});

export const discoverEvents = async (query: DiscoveryQuery) => {
  const key = cacheKey('list', query);
  const cached = await readDiscoveryCache<Awaited<ReturnType<typeof queryEvents>>>(key);
  if (cached) return cached;
  const result = await queryEvents(query);
  await writeDiscoveryCache(key, result);
  return result;
};

const queryEvents = async (query: DiscoveryQuery) => {
  const where: Prisma.EventWhereInput = {
    status: EventStatus.PUBLISHED,
    deletedAt: null,
    ...(query.category ? { category: { equals: query.category, mode: 'insensitive' } } : {}),
    ...(query.city ? { city: { equals: query.city, mode: 'insensitive' } } : {}),
    ...(query.startAfter || query.startBefore
      ? {
          startAt: {
            ...(query.startAfter ? { gte: query.startAfter } : {}),
            ...(query.startBefore ? { lte: query.startBefore } : {}),
          },
        }
      : {}),
    ...(query.search
      ? {
          OR: [
            { title: { contains: query.search, mode: 'insensitive' } },
            { description: { contains: query.search, mode: 'insensitive' } },
            { category: { contains: query.search, mode: 'insensitive' } },
            { city: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
  const orderBy: Prisma.EventOrderByWithRelationInput =
    query.sort === 'latest'
      ? { startAt: 'desc' }
      : query.sort === 'newest'
        ? { createdAt: 'desc' }
        : query.sort === 'title'
          ? { title: 'asc' }
          : { startAt: 'asc' };
  const skip = (query.page - 1) * query.limit;
  const database = getPrisma();
  const [events, total] = await database.$transaction([
    database.event.findMany({
      where,
      orderBy,
      skip,
      take: query.limit,
      include: { ticketTiers: { where: { deletedAt: null }, select: publicTierSelect } },
    }),
    database.event.count({ where }),
  ]);
  return {
    events: events.map(addAvailability),
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
};

export const getPublicEvent = async (slug: string) => {
  const key = cacheKey('detail', slug);
  const cached = await readDiscoveryCache<Awaited<ReturnType<typeof findPublicEvent>>>(key);
  if (cached) return cached;
  const event = await findPublicEvent(slug);
  if (!event) {
    throw new AppError({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Event not found',
      errors: [{ code: 'NOT_FOUND', message: 'Event not found.' }],
    });
  }
  const result = addAvailability(event);
  await writeDiscoveryCache(key, result);
  return result;
};

const findPublicEvent = (slug: string) =>
  getPrisma().event.findFirst({
    where: { slug, status: EventStatus.PUBLISHED, deletedAt: null },
    include: {
      ticketTiers: {
        where: { deletedAt: null },
        select: publicTierSelect,
        orderBy: { pricePaisa: 'asc' },
      },
    },
  });
