import { EventStatus, Prisma } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';

import { findOwnedEvent } from '../events/events.service.js';
import { invalidatePublicDiscoveryCache } from '../public-events/public-events.cache.js';
import type { CreateTicketTierInput, UpdateTicketTierInput } from './ticket-tiers.schemas.js';
import { tierCapabilities, eventCapabilities } from '../../shared/domain/capabilities.js';
import type { PaginationQuery } from '../../shared/responses/pagination.js';
import { serializableTransaction } from '../../lib/transaction.js';

type Actor = Express.Request['auth'];

const tierNotFound = (): AppError =>
  new AppError({
    statusCode: 404,
    code: 'NOT_FOUND',
    message: 'Ticket tier not found',
    errors: [{ code: 'NOT_FOUND', message: 'Ticket tier not found.' }],
  });

const conflict = (code: string, message: string, detail: string): AppError =>
  new AppError({ statusCode: 409, code, message, errors: [{ code, message: detail }] });

const invalidSalesWindow = (message: string): AppError =>
  new AppError({
    statusCode: 400,
    code: 'INVALID_SALES_WINDOW',
    message: 'Invalid sales window',
    errors: [{ code: 'INVALID_SALES_WINDOW', message }],
  });

const findOwnedTier = async (eventId: string, tierId: string) => {
  const tier = await getPrisma().ticketTier.findFirst({
    where: { id: tierId, eventId, deletedAt: null },
  });
  if (!tier) throw tierNotFound();
  return tier;
};

const assertDraftEvent = (status: EventStatus) => {
  if (status !== EventStatus.DRAFT) {
    throw conflict(
      'INVALID_EVENT_TRANSITION',
      'Ticket tiers can only be changed on draft events',
      'Cancel or complete the event before changing its ticket tiers.',
    );
  }
};

export const listManagedTiers = async (actor: Actor, eventId: string, query: PaginationQuery) => {
  const event = await findOwnedEvent(eventId, actor);
  const where = { eventId, deletedAt: null };
  const [tiers, total] = await getPrisma().$transaction([
    getPrisma().ticketTier.findMany({
      where,
      include: { _count: { select: { orders: true } } },
      orderBy: [{ pricePaisa: 'asc' }, { id: 'asc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    getPrisma().ticketTier.count({ where }),
  ]);
  return {
    tiers: tiers.map((tier) => ({
      ...tier,
      ...tierCapabilities(event, tier, tier._count.orders > 0),
      serverTime: new Date(),
    })),
    total,
  };
};

const assertSalesWindow = (
  salesStartAt: Date,
  salesEndAt: Date,
  eventStartAt: Date,
  requireFutureStart = false,
) => {
  if (requireFutureStart && salesStartAt < new Date()) {
    throw invalidSalesWindow('Sales cannot start in the past.');
  }
  if (salesEndAt <= salesStartAt) throw invalidSalesWindow('Sales end must be after sales start.');
  if (salesEndAt > eventStartAt) {
    throw invalidSalesWindow('Sales must end on or before the event start time.');
  }
};

export const createTicketTier = async (
  actor: Actor,
  eventId: string,
  input: CreateTicketTierInput,
) => {
  const event = await findOwnedEvent(eventId, actor);
  if (!eventCapabilities(event, 0, 0).canManageTiers) assertDraftEvent(event.status);
  assertSalesWindow(input.salesStartAt, input.salesEndAt, event.startAt, true);
  const tier = await getPrisma().$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "Event" WHERE "id" = ${eventId}::uuid FOR UPDATE`,
    );
    const current = await findOwnedEvent(eventId, actor, tx);
    assertDraftEvent(current.status);
    assertSalesWindow(input.salesStartAt, input.salesEndAt, current.startAt, true);
    const tier = await tx.ticketTier.create({ data: { ...input, eventId: event.id } });
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        action: 'TICKET_TIER_CREATED',
        entityType: 'TICKET_TIER',
        entityId: tier.id,
      },
    });
    return tier;
  });
  await invalidatePublicDiscoveryCache();
  return tier;
};

export const updateTicketTier = async (
  actor: Actor,
  eventId: string,
  tierId: string,
  input: UpdateTicketTierInput,
) => {
  const event = await findOwnedEvent(eventId, actor);
  assertDraftEvent(event.status);
  const tier = await findOwnedTier(event.id, tierId);
  const database = getPrisma();
  const hasOrderHistory = (await database.order.count({ where: { ticketTierId: tier.id } })) > 0;
  const capabilities = tierCapabilities(event, tier, hasOrderHistory);

  if (
    capabilities.restrictionCodes.includes('TIER_HISTORY_LOCKED') &&
    (input.pricePaisa !== undefined || input.name !== undefined || input.salesStartAt !== undefined)
  ) {
    throw conflict(
      'TIER_HISTORY_LOCKED',
      'Ticket tier fields are locked',
      'Name, price, and sales start cannot change after order history exists.',
    );
  }
  if (input.capacity !== undefined && input.capacity < tier.reservedQuantity + tier.soldQuantity) {
    throw conflict(
      'CAPACITY_TOO_LOW',
      'Capacity is below reserved and sold tickets',
      'Capacity cannot invalidate inventory.',
    );
  }
  if (hasOrderHistory && input.capacity !== undefined && input.capacity < tier.capacity) {
    throw conflict(
      'CAPACITY_REDUCTION_LOCKED',
      'Capacity cannot be reduced after orders exist',
      'Capacity may only increase after order history exists.',
    );
  }

  const salesStartAt = input.salesStartAt ?? tier.salesStartAt;
  const salesEndAt = input.salesEndAt ?? tier.salesEndAt;
  assertSalesWindow(salesStartAt, salesEndAt, event.startAt, input.salesStartAt !== undefined);
  const data = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Prisma.TicketTierUpdateInput;
  if (Object.keys(data).length === 0) return tier;

  const updated = await serializableTransaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "Event" WHERE "id" = ${eventId}::uuid FOR UPDATE`,
    );
    const currentEvent = await findOwnedEvent(eventId, actor, tx);
    const currentTier = await tx.ticketTier.findFirst({
      where: { id: tierId, eventId, deletedAt: null },
    });
    if (!currentTier) throw tierNotFound();
    const history = await tx.order.count({ where: { ticketTierId: tierId } });
    const currentCapabilities = tierCapabilities(currentEvent, currentTier, history > 0);
    if (
      !currentCapabilities.canEdit ||
      Object.keys(data).some((field) => !currentCapabilities.editableFields.includes(field))
    )
      throw conflict(
        'TIER_HISTORY_LOCKED',
        'Tier fields are locked',
        'Reload the tier capabilities.',
      );
    if (input.capacity !== undefined && input.capacity < currentCapabilities.minimumCapacity)
      throw conflict(
        'CAPACITY_TOO_LOW',
        'Capacity is too low',
        'Capacity cannot invalidate existing inventory.',
      );
    assertSalesWindow(
      input.salesStartAt ?? currentTier.salesStartAt,
      input.salesEndAt ?? currentTier.salesEndAt,
      currentEvent.startAt,
      input.salesStartAt !== undefined,
    );
    const updated = await tx.ticketTier.update({ where: { id: tier.id }, data });
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        action: 'TICKET_TIER_UPDATED',
        entityType: 'TICKET_TIER',
        entityId: tier.id,
        metadata: { fields: Object.keys(data) },
      },
    });
    return updated;
  });
  await invalidatePublicDiscoveryCache();
  return updated;
};

export const softDeleteTicketTier = async (actor: Actor, eventId: string, tierId: string) => {
  const event = await findOwnedEvent(eventId, actor);
  assertDraftEvent(event.status);
  const tier = await findOwnedTier(event.id, tierId);
  await getPrisma().$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "Event" WHERE "id" = ${eventId}::uuid FOR UPDATE`,
    );
    const currentEvent = await findOwnedEvent(eventId, actor, tx);
    const orderCount = await tx.order.count({ where: { ticketTierId: tier.id } });
    if (!tierCapabilities(currentEvent, tier, orderCount > 0).canDelete) {
      throw conflict(
        'TIER_HAS_ORDERS',
        'Ticket tier has order history',
        'Close sales instead of deleting this tier.',
      );
    }
    await tx.ticketTier.update({ where: { id: tier.id }, data: { deletedAt: new Date() } });
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        action: 'TICKET_TIER_DELETED',
        entityType: 'TICKET_TIER',
        entityId: tier.id,
      },
    });
  });
  await invalidatePublicDiscoveryCache();
};
