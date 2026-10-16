import { EventStatus, type Prisma } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';

import { readDiscoveryCache, writeDiscoveryCache } from './public-events.cache.js';
import type { DiscoveryQuery } from './public-events.schemas.js';
import { publicEventSelect } from '../../shared/responses/read-contracts.js';
import { tierCapabilities } from '../../shared/domain/capabilities.js';

export const publicTierSelect = {
  id: true,
  name: true,
  pricePaisa: true,
  capacity: true,
  reservedQuantity: true,
  soldQuantity: true,
  salesStartAt: true,
  salesEndAt: true,
  salesPaused: true,
} satisfies Prisma.TicketTierSelect;

const cacheKey = (name: string, value: unknown): string =>
  `safe-v4:${name}:${Buffer.from(JSON.stringify(value)).toString('base64url')}`;

export const publicProjection = (
  event: NonNullable<Awaited<ReturnType<typeof findPublicEvent>>>,
) => ({
  id: event.id,
  title: event.title,
  slug: event.slug,
  description: event.description,
  category: event.category,
  venue: event.venue,
  city: event.city,
  address: event.address,
  startAt: event.startAt,
  endAt: event.endAt,
  imageUrl: event.imageUrl,
  organizer: { displayName: event.organizer.displayName },
  ticketTiers: event.ticketTiers.map((tier) => ({
    id: tier.id,
    name: tier.name,
    pricePaisa: tier.pricePaisa,
    capacity: tier.capacity,
    availableQuantity: Math.max(0, tier.capacity - tier.reservedQuantity - tier.soldQuantity),
    salesStartAt: tier.salesStartAt,
    salesEndAt: tier.salesEndAt,
    salesPaused: tier.salesPaused,
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
            ...(query.startBefore ? { lt: query.startBefore } : {}),
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
  // Independent catalogue reads do not need a transaction/extra BEGIN and COMMIT
  // round trips. Reservation writes still use the inventory transaction.
  const [events, total] = await Promise.all([
    database.event.findMany({
      where,
      orderBy: [orderBy, { id: 'asc' }],
      skip,
      take: query.limit,
      select: {
        ...publicEventSelect,
        ticketTiers: {
          where: { deletedAt: null },
          select: publicTierSelect,
          orderBy: [{ pricePaisa: 'asc' }, { id: 'asc' }],
        },
      },
    }),
    database.event.count({ where }),
  ]);
  return {
    events: events.map(publicProjection),
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
  const cached = await readDiscoveryCache<ReturnType<typeof publicProjection>>(key);
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
  const result = publicProjection(event);
  await writeDiscoveryCache(key, result);
  return result;
};

const findPublicEvent = (slug: string) =>
  getPrisma().event.findFirst({
    where: { slug, status: EventStatus.PUBLISHED, deletedAt: null },
    select: {
      ...publicEventSelect,
      ticketTiers: {
        where: { deletedAt: null },
        select: publicTierSelect,
        orderBy: [{ pricePaisa: 'asc' }, { id: 'asc' }],
      },
    },
  });

export const getEventFacets = async () => {
  const key = 'safe-v2:facets';
  const cached = await readDiscoveryCache<{ categories: string[]; cities: string[] }>(key);
  if (cached) return cached;
  const where = { status: EventStatus.PUBLISHED, deletedAt: null };
  const [categories, cities] = await Promise.all([
    getPrisma().event.groupBy({ by: ['category'], where, orderBy: { category: 'asc' } }),
    getPrisma().event.groupBy({ by: ['city'], where, orderBy: { city: 'asc' } }),
  ]);
  const result = {
    categories: categories.map((row) => row.category),
    cities: cities.map((row) => row.city),
  };
  await writeDiscoveryCache(key, result);
  return result;
};

export const getPublicAvailability = async (slug: string) => {
  // Availability needs stock and sale windows, not descriptions or organizer joins.
  const event = await getPrisma().event.findFirst({
    where: { slug, status: EventStatus.PUBLISHED, deletedAt: null },
    select: {
      id: true,
      status: true,
      startAt: true,
      endAt: true,
      ticketTiers: {
        where: { deletedAt: null },
        select: publicTierSelect,
        orderBy: [{ pricePaisa: 'asc' }, { id: 'asc' }],
      },
    },
  });
  if (!event)
    throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: 'Event not found.' });
  const serverTime = new Date();
  return {
    eventId: event.id,
    status: event.status,
    serverTime,
    ticketTiers: event.ticketTiers.map((tier) => {
      const { availableQuantity, saleState } = tierCapabilities(event, tier, false, serverTime);
      return {
        id: tier.id,
        name: tier.name,
        pricePaisa: tier.pricePaisa,
        capacity: tier.capacity,
        availableQuantity,
        salesStartAt: tier.salesStartAt,
        salesEndAt: tier.salesEndAt,
        salesPaused: tier.salesPaused,
        saleState,
        canPurchase: saleState === 'OPEN',
      };
    }),
  };
};
