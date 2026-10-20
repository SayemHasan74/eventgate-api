import { EventStatus, Prisma } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';

import { cachedDiscovery } from './public-events.cache.js';
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
  `safe-v5:${name}:${Buffer.from(JSON.stringify(value)).toString('base64url')}`;

export const publicProjection = (
  event: NonNullable<Awaited<ReturnType<typeof findPublicEvent>>>,
) => ({
  id: event.id,
  title: event.title,
  status: event.status,
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

export const discoverEvents = (query: DiscoveryQuery) =>
  cachedDiscovery(cacheKey('list', query), () => queryEvents(query));

const queryEvents = async (query: DiscoveryQuery) => {
  const database = getPrisma();
  const now = new Date();
  const budgetFilter =
    query.maxPricePaisa === undefined
      ? []
      : [
          Prisma.sql`
    SELECT 1 FROM "TicketTier" t WHERE t."eventId" = e."id" AND t."deletedAt" IS NULL
      AND NOT t."salesPaused" AND t."pricePaisa" <= ${query.maxPricePaisa}
      AND t."salesStartAt" <= ${now} AND t."salesEndAt" > ${now}
      AND t."capacity" > t."soldQuantity" + t."reservedQuantity"
  `,
        ];
  const where: Prisma.EventWhereInput = {
    status: EventStatus.PUBLISHED,
    deletedAt: null,

    ...(query.category ? { category: { equals: query.category, mode: 'insensitive' } } : {}),
    ...(query.city ? { city: { equals: query.city, mode: 'insensitive' } } : {}),
    ...(query.startAfter || query.startBefore || budgetFilter.length
      ? {
          startAt: {
            ...(budgetFilter.length ? { gt: now } : {}),
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
  if (budgetFilter.length) {
    const matches = await database.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT e."id" FROM "Event" e WHERE e."status" = 'PUBLISHED' AND e."deletedAt" IS NULL
        AND e."startAt" > ${now}
        ${query.category ? Prisma.sql`AND lower(e."category") = lower(${query.category})` : Prisma.empty}
        ${query.city ? Prisma.sql`AND lower(e."city") = lower(${query.city})` : Prisma.empty}
        ${query.startAfter ? Prisma.sql`AND e."startAt" >= ${query.startAfter}` : Prisma.empty}
        ${query.startBefore ? Prisma.sql`AND e."startAt" < ${query.startBefore}` : Prisma.empty}
        AND EXISTS (${budgetFilter[0]!})
    `);
    where.id = { in: matches.map((row) => row.id) };
  }
  const orderBy: Prisma.EventOrderByWithRelationInput =
    query.sort === 'latest'
      ? { startAt: 'desc' }
      : query.sort === 'newest'
        ? { createdAt: 'desc' }
        : query.sort === 'title'
          ? { title: 'asc' }
          : { startAt: 'asc' };
  const skip = (query.page - 1) * query.limit;
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

export const getPublicEvent = (slug: string) =>
  cachedDiscovery(
    cacheKey('detail', slug),
    async () => {
      const event = await findPublicEvent(slug);
      if (!event)
        throw new AppError({
          statusCode: 404,
          code: 'NOT_FOUND',
          message: 'Event not found',
          errors: [{ code: 'NOT_FOUND', message: 'Event not found.' }],
        });
      return publicProjection(event);
    },
    `event:${slug}`,
  );

const findPublicEvent = (slug: string) =>
  getPrisma().event.findFirst({
    where: {
      slug,
      deletedAt: null,
      OR: [
        { status: EventStatus.PUBLISHED },
        {
          status: { in: [EventStatus.COMPLETED, EventStatus.CANCELLED] },
          publishedAt: { not: null },
        },
      ],
    },
    select: {
      ...publicEventSelect,
      ticketTiers: {
        where: { deletedAt: null },
        select: publicTierSelect,
        orderBy: [{ pricePaisa: 'asc' }, { id: 'asc' }],
      },
    },
  });

export const getEventFacets = () =>
  cachedDiscovery(
    'facets',
    async () => {
      const where = { status: EventStatus.PUBLISHED, deletedAt: null };
      const [categories, cities] = await Promise.all([
        getPrisma().event.groupBy({ by: ['category'], where, orderBy: { category: 'asc' } }),
        getPrisma().event.groupBy({ by: ['city'], where, orderBy: { city: 'asc' } }),
      ]);
      return {
        categories: categories.map((row) => row.category),
        cities: cities.map((row) => row.city),
      };
    },
    'facets',
  );

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
