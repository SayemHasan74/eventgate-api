import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import { publicEventSelect } from '../../shared/responses/read-contracts.js';
import { publicProjection, publicTierSelect } from '../public-events/public-events.service.js';
import { tierCapabilities } from '../../shared/domain/capabilities.js';

export const preferenceInput = z
  .object({
    preferredCity: z.string().trim().min(1).max(100).nullable(),
    preferredCategories: z.array(z.string().trim().min(1).max(80)).max(5),
    personalizationEnabled: z.boolean(),
  })
  .strict();
export const recommendationQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(12).default(6),
  })
  .strict();
const defaults = { preferredCity: null, preferredCategories: [], personalizationEnabled: false };
const fold = (value: string) => value.trim().toLowerCase();
const distinct = (values: string[]) => [
  ...new Map(values.map((value) => [fold(value), value])).values(),
];

export async function preferences(userId: string) {
  const db = getPrisma();
  const [profile, categories, cities] = await Promise.all([
    db.eventPreference.findUnique({
      where: { userId },
      select: {
        preferredCity: true,
        preferredCategories: true,
        personalizationEnabled: true,
      },
    }),
    db.event.groupBy({
      by: ['category'],
      where: { deletedAt: null, status: 'PUBLISHED' },
      orderBy: { category: 'asc' },
    }),
    db.event.groupBy({
      by: ['city'],
      where: { deletedAt: null, status: 'PUBLISHED' },
      orderBy: { city: 'asc' },
    }),
  ]);
  return {
    ...(profile ?? defaults),
    options: {
      categories: distinct(categories.map((row) => row.category)),
      cities: distinct(cities.map((row) => row.city)),
    },
  };
}

export async function updatePreferences(userId: string, input: z.infer<typeof preferenceInput>) {
  const current = await preferences(userId);
  const canonical = (value: string, options: string[], previous: string[], field: string) => {
    // Preserve an existing choice if its last published event disappeared; new choices must exist.
    const match = [...options, ...previous].find((option) => fold(option) === fold(value));
    if (!match)
      throw new AppError({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Choose an existing event city or category.',
        errors: [{ code: 'INVALID_PREFERENCE', field, message: 'Choose an existing value.' }],
      });
    return match;
  };
  const data = {
    personalizationEnabled: input.personalizationEnabled,
    preferredCity:
      input.preferredCity === null
        ? null
        : canonical(
            input.preferredCity,
            current.options.cities,
            current.preferredCity ? [current.preferredCity] : [],
            'preferredCity',
          ),
    preferredCategories: distinct(
      input.preferredCategories.map((value) =>
        canonical(
          value,
          current.options.categories,
          current.preferredCategories,
          'preferredCategories',
        ),
      ),
    ),
  };
  await getPrisma().eventPreference.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
  return { ...data, options: current.options };
}

type Ranked = { id: string; reason: string | null; personalized: boolean };
export async function recommendedEvents(userId: string, limit: number) {
  const now = new Date();
  return getPrisma().$transaction(
    async (db) => {
      const preference = await db.eventPreference.findUnique({ where: { userId } });
      const categories = preference?.preferredCategories.map(fold) ?? [];
      const categoryArray = categories.length
        ? Prisma.sql`ARRAY[${Prisma.join(categories)}]::text[]`
        : Prisma.sql`ARRAY[]::text[]`;
      // Rank the entire eligible catalog in the database, not an arbitrary first page.
      const ranked = await db.$queryRaw<Ranked[]>(Prisma.sql`
      WITH candidates AS (
        SELECT e."id", e."startAt",
          CASE WHEN lower(trim(e."category")) = ANY(${categoryArray}) THEN 4 ELSE 0 END AS category_score,
          CASE WHEN lower(trim(e."city")) = ${fold(preference?.preferredCity ?? '')} THEN 3 ELSE 0 END AS city_score,
          CASE WHEN EXISTS (
            SELECT 1 FROM "SavedEvent" s JOIN "Event" saved ON saved."id" = s."eventId"
            WHERE s."userId" = ${userId}::uuid AND saved."status" = 'PUBLISHED'
              AND saved."deletedAt" IS NULL AND saved."startAt" > ${now}
              AND lower(trim(saved."category")) = lower(trim(e."category"))
          ) THEN 2 ELSE 0 END AS saved_score
        FROM "Event" e WHERE e."status" = 'PUBLISHED' AND e."deletedAt" IS NULL
          AND e."startAt" > ${now} AND e."endAt" > ${now}
          AND NOT EXISTS (
            SELECT 1 FROM "Order" o JOIN "Ticket" t ON t."orderId" = o."id"
            WHERE o."attendeeId" = ${userId}::uuid AND o."eventId" = e."id"
              AND o."status" = 'PAID' AND t."status" IN ('ACTIVE', 'CHECKED_IN')
          )
      ), mode AS (
        SELECT ${preference?.personalizationEnabled ?? false} AND EXISTS (
          SELECT 1 FROM candidates WHERE category_score + city_score + saved_score > 0
        ) AS personalized
      )
      SELECT c."id", m.personalized,
        CASE WHEN NOT m.personalized THEN NULL
          WHEN category_score > 0 THEN 'Matches your preferred category'
          WHEN city_score > 0 THEN 'In your preferred city'
          WHEN saved_score > 0 THEN 'Similar to your saved events' ELSE NULL END AS reason
      FROM candidates c CROSS JOIN mode m
      WHERE NOT m.personalized OR category_score + city_score + saved_score > 0
      ORDER BY CASE WHEN m.personalized THEN category_score + city_score + saved_score +
        CASE WHEN c."startAt" <= ${new Date(now.getTime() + 14 * 86400000)} THEN 1 ELSE 0 END
        ELSE 0 END DESC, c."startAt" ASC, c."id" ASC LIMIT ${limit}
    `);
      const events = await db.event.findMany({
        where: { id: { in: ranked.map((row) => row.id) } },
        select: {
          ...publicEventSelect,
          ticketTiers: {
            where: { deletedAt: null },
            select: publicTierSelect,
            orderBy: [{ pricePaisa: 'asc' }, { id: 'asc' }],
          },
        },
      });
      const byId = new Map(events.map((event) => [event.id, event]));
      const personalized = ranked[0]?.personalized ?? false;
      return {
        heading: personalized ? 'Chosen for you' : 'Upcoming events',
        personalized,
        serverTime: now,
        events: ranked.flatMap((row) => {
          const event = byId.get(row.id);
          if (!event) return [];
          return [
            {
              event: publicProjection(event),
              reason: row.reason,
              canPurchase: event.ticketTiers.some(
                (tier) => tierCapabilities(event, tier, false, now).saleState === 'OPEN',
              ),
            },
          ];
        }),
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
