import { EventStatus, type Prisma } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';

import { findOwnedEvent } from '../events/events.service.js';
import type { CreateTicketTierInput, UpdateTicketTierInput } from './ticket-tiers.schemas.js';

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
  assertDraftEvent(event.status);
  assertSalesWindow(input.salesStartAt, input.salesEndAt, event.startAt, true);
  return getPrisma().$transaction(async (tx) => {
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

  if (
    hasOrderHistory &&
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

  return database.$transaction(async (tx) => {
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
};

export const softDeleteTicketTier = async (actor: Actor, eventId: string, tierId: string) => {
  const event = await findOwnedEvent(eventId, actor);
  assertDraftEvent(event.status);
  const tier = await findOwnedTier(event.id, tierId);
  return getPrisma().$transaction(async (tx) => {
    const orderCount = await tx.order.count({ where: { ticketTierId: tier.id } });
    if (orderCount > 0) {
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
};
