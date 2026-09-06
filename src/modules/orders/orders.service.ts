import { createHash } from 'node:crypto';

import { IdempotencyStatus, OrderStatus, Prisma } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import { invalidatePublicDiscoveryCache } from '../public-events/public-events.cache.js';

import type { CreateOrderInput, OrderListQuery } from './orders.schemas.js';

const reservationLifetimeMilliseconds = 15 * 60 * 1000;
const createOrderScope = (attendeeId: string) => `order:create:${attendeeId}`;

const orderSelect = {
  id: true,
  eventId: true,
  ticketTierId: true,
  eventNameSnapshot: true,
  ticketTierNameSnapshot: true,
  unitPricePaisaSnapshot: true,
  quantity: true,
  totalAmountPaisaSnapshot: true,
  currency: true,
  status: true,
  reservationExpiresAt: true,
  reservationReleasedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OrderSelect;

const notFound = (): AppError =>
  new AppError({
    statusCode: 404,
    code: 'NOT_FOUND',
    message: 'Order not found',
    errors: [{ code: 'NOT_FOUND', message: 'Order not found.' }],
  });

const conflict = (code: string, message: string, detail: string): AppError =>
  new AppError({ statusCode: 409, code, message, errors: [{ code, message: detail }] });

const requestHash = (input: CreateOrderInput): string =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');

const isRetryableTransactionError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  (error.code === 'P2034' || error.code === 'P2002');

const withSerializableRetry = async <T>(work: () => Promise<T>): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (!isRetryableTransactionError(error) || attempt === 2) throw error;
    }
  }
  throw lastError;
};

const getOrderForAttendee = async (attendeeId: string, orderId: string) => {
  const order = await getPrisma().order.findFirst({
    where: { id: orderId, attendeeId },
    select: orderSelect,
  });
  if (!order) throw notFound();
  return order;
};

export const createOrder = async (
  attendeeId: string,
  idempotencyKey: string,
  input: CreateOrderInput,
) => {
  const hash = requestHash(input);
  const order = await withSerializableRetry(() =>
    getPrisma().$transaction(
      async (tx) => {
        const scope = createOrderScope(attendeeId);
        const previous = await tx.idempotencyRecord.findUnique({
          where: { scope_key: { scope, key: idempotencyKey } },
        });
        if (previous) {
          if (previous.requestHash !== hash) {
            throw conflict(
              'IDEMPOTENCY_KEY_REUSED',
              'Idempotency key was reused for a different request',
              'Use a new Idempotency-Key for a different order request.',
            );
          }
          if (previous.status === IdempotencyStatus.COMPLETED && previous.resourceId) {
            const existingOrder = await tx.order.findFirst({
              where: { id: previous.resourceId, attendeeId },
              select: orderSelect,
            });
            if (existingOrder) return existingOrder;
          }
          throw conflict(
            'IDEMPOTENCY_REQUEST_IN_PROGRESS',
            'Order request is already being processed',
            'Retry the same Idempotency-Key shortly.',
          );
        }

        const tier = await tx.ticketTier.findFirst({
          where: { id: input.ticketTierId, deletedAt: null },
          include: { event: true },
        });
        if (!tier || tier.event.deletedAt || tier.event.status !== 'PUBLISHED') {
          throw conflict(
            'TIER_NOT_ON_SALE',
            'Ticket tier is not available for purchase',
            'Choose a published event with an active ticket tier.',
          );
        }

        const reservation = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
          UPDATE "TicketTier" AS tier
          SET "reservedQuantity" = tier."reservedQuantity" + ${input.quantity}
          FROM "Event" AS event
          WHERE tier."id" = ${tier.id}
            AND event."id" = tier."eventId"
            AND event."status" = 'PUBLISHED'
            AND event."deletedAt" IS NULL
            AND event."startAt" > NOW()
            AND tier."deletedAt" IS NULL
            AND tier."salesStartAt" <= NOW()
            AND tier."salesEndAt" >= NOW()
            AND tier."reservedQuantity" + tier."soldQuantity" + ${input.quantity} <= tier."capacity"
          RETURNING tier."id"
        `);
        if (reservation.length === 0) {
          throw conflict(
            'INSUFFICIENT_INVENTORY',
            'Tickets are no longer available',
            'The event is not on sale or the requested quantity is unavailable.',
          );
        }

        const expiresAt = new Date(Date.now() + reservationLifetimeMilliseconds);
        const created = await tx.order.create({
          data: {
            attendeeId,
            eventId: tier.eventId,
            ticketTierId: tier.id,
            eventNameSnapshot: tier.event.title,
            ticketTierNameSnapshot: tier.name,
            unitPricePaisaSnapshot: tier.pricePaisa,
            quantity: input.quantity,
            totalAmountPaisaSnapshot: tier.pricePaisa * input.quantity,
            reservationExpiresAt: expiresAt,
          },
          select: orderSelect,
        });
        await tx.idempotencyRecord.create({
          data: {
            userId: attendeeId,
            scope,
            key: idempotencyKey,
            requestHash: hash,
            status: IdempotencyStatus.COMPLETED,
            responseStatus: 201,
            resourceId: created.id,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: attendeeId,
            action: 'ORDER_CREATED',
            entityType: 'ORDER',
            entityId: created.id,
            metadata: { ticketTierId: tier.id, quantity: input.quantity },
          },
        });
        return created;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  await invalidatePublicDiscoveryCache();
  return order;
};

export const listOrders = async (attendeeId: string, query: OrderListQuery) => {
  const where: Prisma.OrderWhereInput = {
    attendeeId,
    ...(query.status ? { status: query.status } : {}),
  };
  const skip = (query.page - 1) * query.limit;
  const database = getPrisma();
  const [orders, total] = await database.$transaction([
    database.order.findMany({
      where,
      select: orderSelect,
      orderBy: { createdAt: 'desc' },
      skip,
      take: query.limit,
    }),
    database.order.count({ where }),
  ]);
  return { orders, page: query.page, limit: query.limit, total };
};

export const getOrder = (attendeeId: string, orderId: string) =>
  getOrderForAttendee(attendeeId, orderId);

export const cancelOrder = async (attendeeId: string, orderId: string) => {
  await withSerializableRetry(() =>
    getPrisma().$transaction(
      async (tx) => {
        const order = await tx.order.findFirst({ where: { id: orderId, attendeeId } });
        if (!order) throw notFound();
        const releasedAt = new Date();
        const cancelled = await tx.order.updateMany({
          where: {
            id: order.id,
            status: OrderStatus.PENDING_PAYMENT,
            reservationReleasedAt: null,
          },
          data: { status: OrderStatus.CANCELLED, reservationReleasedAt: releasedAt },
        });
        if (cancelled.count !== 1) {
          throw conflict(
            'ORDER_NOT_CANCELLABLE',
            'Order cannot be cancelled',
            'Only an active pending-payment order can be cancelled.',
          );
        }
        const released = await tx.$executeRaw(Prisma.sql`
          UPDATE "TicketTier"
          SET "reservedQuantity" = "reservedQuantity" - ${order.quantity}
          WHERE "id" = ${order.ticketTierId}
            AND "reservedQuantity" >= ${order.quantity}
        `);
        if (released !== 1) {
          throw new AppError({
            statusCode: 500,
            code: 'INVENTORY_RELEASE_FAILED',
            message: 'Order cancellation could not release inventory',
            errors: [
              { code: 'INVENTORY_RELEASE_FAILED', message: 'Inventory state needs review.' },
            ],
          });
        }
        await tx.auditLog.create({
          data: {
            actorId: attendeeId,
            action: 'ORDER_CANCELLED',
            entityType: 'ORDER',
            entityId: order.id,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  await invalidatePublicDiscoveryCache();
};
