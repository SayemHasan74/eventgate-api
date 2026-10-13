import { Prisma } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import { findOwnedEvent, currentOrganizer } from '../events/events.service.js';
import { invalidatePublicDiscoveryCache } from '../public-events/public-events.cache.js';
import type { CreateTicketTierInput, UpdateTicketTierInput } from './ticket-tiers.schemas.js';
import { tierCapabilities } from '../../shared/domain/capabilities.js';
import type { PaginationQuery } from '../../shared/responses/pagination.js';
import { serializableTransaction } from '../../lib/transaction.js';
import { refreshEventReminders } from '../saved-events/reminders.service.js';
import {
  recordInventoryRelease,
  scheduleWaitlistClosure,
} from '../waitlists/availability.service.js';
type Actor = Express.Request['auth'];
const fail = (code: string, message: string, field?: string): never => {
  throw new AppError({
    statusCode: 409,
    code,
    message,
    errors: [{ code, message, ...(field ? { field } : {}) }],
  });
};
const assertSalesWindow = (
  start: Date,
  end: Date,
  eventStart: Date,
  requireFutureStart = false,
  now = new Date(),
) => {
  if (requireFutureStart && start <= now)
    fail('INVALID_SALES_WINDOW', 'Sales must start in the future.', 'salesStartAt');
  if (end <= start)
    fail('INVALID_SALES_WINDOW', 'Sales end must follow sales start.', 'salesEndAt');
  if (end > eventStart)
    fail('INVALID_SALES_WINDOW', 'Sales must end no later than the event start.', 'salesEndAt');
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
  const now = new Date();
  return {
    tiers: tiers.map((tier) => ({
      ...tier,
      ...tierCapabilities(event, tier, tier._count.orders > 0, now),
      serverTime: now,
    })),
    total,
  };
};
const lockEvent = async (tx: Prisma.TransactionClient, actor: Actor, eventId: string) => {
  const currentActor = await currentOrganizer(tx, actor.id);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Event" WHERE "id" = ${eventId}::uuid FOR UPDATE`);
  return findOwnedEvent(eventId, currentActor, tx);
};
export const createTicketTier = async (
  actor: Actor,
  eventId: string,
  input: CreateTicketTierInput,
) => {
  const tier = await serializableTransaction(async (tx) => {
    const event = await lockEvent(tx, actor, eventId);
    if (event.status !== 'DRAFT')
      fail('EVENT_INVENTORY_LOCKED', 'New tiers can only be created on draft events.');
    assertSalesWindow(input.salesStartAt, input.salesEndAt, event.startAt, true);
    const created = await tx.ticketTier.create({
      data: { ...input, salesPaused: input.salesPaused ?? false, eventId },
    });
    await refreshEventReminders(tx, eventId);
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        action: 'TICKET_TIER_CREATED',
        entityType: 'TICKET_TIER',
        entityId: created.id,
      },
    });
    return created;
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
  const updated = await serializableTransaction(async (tx) => {
    const event = await lockEvent(tx, actor, eventId);
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "TicketTier" WHERE "id" = ${tierId}::uuid AND "eventId" = ${eventId}::uuid FOR UPDATE`,
    );
    const tier = await tx.ticketTier.findFirst({ where: { id: tierId, eventId, deletedAt: null } });
    if (!tier)
      throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: 'Ticket tier not found.' });
    const history = await tx.order.count({ where: { ticketTierId: tierId } });
    const now = new Date();
    const capabilities = tierCapabilities(event, tier, history > 0, now);
    if (!capabilities.canEdit)
      fail('EVENT_INVENTORY_LOCKED', 'Inventory is read-only for this event.');
    const { closeSales, ...fields } = input;
    const data = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    ) as {
      name?: string;
      pricePaisa?: number;
      capacity?: number;
      salesStartAt?: Date;
      salesEndAt?: Date;
      salesPaused?: boolean;
    };
    if (closeSales) {
      if (!capabilities.canCloseSales)
        fail(
          'SALES_NOT_OPEN',
          'Close sales is available only for an open published window. Pause a future window instead.',
        );
      data.salesEndAt = now;
    }
    for (const field of Object.keys(data))
      if (!capabilities.editableFields.includes(field))
        fail(
          'TIER_FIELD_LOCKED',
          'Name, price and sales start are fixed after publication or order history.',
          field,
        );
    if (data.capacity !== undefined && data.capacity < Math.max(1, capabilities.minimumCapacity))
      fail(
        'CAPACITY_TOO_LOW',
        `Capacity must be at least ${Math.max(1, capabilities.minimumCapacity)}; reserved/sold tickets and historical capacity are protected.`,
        'capacity',
      );
    assertSalesWindow(
      data.salesStartAt ?? tier.salesStartAt,
      data.salesEndAt ?? tier.salesEndAt,
      event.startAt,
      data.salesStartAt !== undefined,
      now,
    );
    if (
      event.status === 'PUBLISHED' &&
      !closeSales &&
      data.salesEndAt !== undefined &&
      data.salesEndAt <= now
    )
      fail(
        'INVALID_SALES_WINDOW',
        'Use Close sales to close an open window. Reopening requires a future sales end.',
        'salesEndAt',
      );
    if (data.salesPaused === false && (data.salesEndAt ?? tier.salesEndAt) <= now)
      fail(
        'SALES_WINDOW_CLOSED',
        'Set a valid future sales end before resuming sales.',
        'salesEndAt',
      );
    const saved = await tx.ticketTier.update({ where: { id: tierId }, data });
    await recordInventoryRelease(
      tx,
      tierId,
      Math.max(0, saved.capacity - tier.capacity),
      tier.salesPaused && !saved.salesPaused,
    );
    await scheduleWaitlistClosure(tx, tierId);
    if (saved.salesEndAt <= now)
      await tx.waitlistEntry.updateMany({
        where: { ticketTierId: tierId, status: { in: ['WAITING', 'NOTIFIED'] } },
        data: { status: 'CLOSED', generation: { increment: 1 } },
      });
    await refreshEventReminders(tx, eventId);
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        action: closeSales
          ? 'TICKET_TIER_SALES_CLOSED'
          : data.salesPaused !== undefined
            ? data.salesPaused
              ? 'TICKET_TIER_SALES_PAUSED'
              : 'TICKET_TIER_SALES_RESUMED'
            : 'TICKET_TIER_UPDATED',
        entityType: 'TICKET_TIER',
        entityId: tierId,
        metadata: { fields: Object.keys(data) },
      },
    });
    return saved;
  });
  await invalidatePublicDiscoveryCache();
  return updated;
};
export const softDeleteTicketTier = async (actor: Actor, eventId: string, tierId: string) => {
  await serializableTransaction(async (tx) => {
    const event = await lockEvent(tx, actor, eventId);
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "TicketTier" WHERE "id" = ${tierId}::uuid AND "eventId" = ${eventId}::uuid FOR UPDATE`,
    );
    const tier = await tx.ticketTier.findFirst({ where: { id: tierId, eventId, deletedAt: null } });
    if (!tier)
      throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: 'Ticket tier not found.' });
    const history = await tx.order.count({ where: { ticketTierId: tierId } });
    if (!tierCapabilities(event, tier, history > 0).canDelete)
      fail(
        'TIER_DELETE_LOCKED',
        'Only draft tiers with no order history can be deleted. Pause or close sales instead.',
      );
    await tx.ticketTier.update({ where: { id: tierId }, data: { deletedAt: new Date() } });
    await refreshEventReminders(tx, eventId);
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        action: 'TICKET_TIER_DELETED',
        entityType: 'TICKET_TIER',
        entityId: tierId,
      },
    });
  });
  await invalidatePublicDiscoveryCache();
};
