import { EventStatus, Prisma, UserRole } from '../../generated/prisma/client.js';
import { serializableTransaction } from '../../lib/transaction.js';
import { getPrisma } from '../../lib/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import { invalidatePublicDiscoveryCache } from '../public-events/public-events.cache.js';

import type { CreateEventInput, UpdateEventInput } from './events.schemas.js';

import type { ManagedEventQuery } from './events.schemas.js';
import { eventCapabilities } from '../../shared/domain/capabilities.js';

type Actor = Express.Request['auth'];

const eventNotFound = (): AppError =>
  new AppError({
    statusCode: 404,
    code: 'NOT_FOUND',
    message: 'Event not found',
    errors: [{ code: 'NOT_FOUND', message: 'Event not found.' }],
  });

const conflict = (code: string, message: string, detail: string): AppError =>
  new AppError({ statusCode: 409, code, message, errors: [{ code, message: detail }] });

const invalidDate = (message: string): AppError =>
  new AppError({
    statusCode: 400,
    code: 'INVALID_EVENT_DATE',
    message,
    errors: [{ code: 'INVALID_EVENT_DATE', message }],
  });

export const findOwnedEvent = async (
  eventId: string,
  actor: Actor,
  database: Prisma.TransactionClient = getPrisma(),
) => {
  const event = await database.event.findFirst({
    where: {
      id: eventId,
      deletedAt: null,
      ...(actor.role === UserRole.ADMIN ? {} : { organizerId: actor.id }),
    },
  });
  if (!event) throw eventNotFound();
  return event;
};

export const listManagedEvents = async (actor: Actor, query: ManagedEventQuery) => {
  const database = getPrisma();
  const base =
    actor.role === UserRole.ADMIN
      ? { deletedAt: null }
      : { organizerId: actor.id, deletedAt: null };
  const where = {
    ...base,
    ...(query.status ? { status: query.status } : {}),
    ...(query.search ? { title: { contains: query.search, mode: 'insensitive' as const } } : {}),
  };
  const [events, total] = await database.$transaction([
    database.event.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    database.event.count({ where }),
  ]);
  const counts = await database.event.groupBy({ by: ['status'], where: base, _count: true });
  return {
    events,
    total,
    summary: Object.fromEntries(counts.map((group) => [group.status, group._count])),
  };
};

export const getManagedEvent = async (actor: Actor, eventId: string, includeDeleted = false) => {
  const event = await getPrisma().event.findFirst({
    where: {
      id: eventId,
      ...(!includeDeleted ? { deletedAt: null } : {}),
      ...(actor.role === 'ADMIN' ? {} : { organizerId: actor.id }),
    },
    include: {
      organizer: { select: { id: true, displayName: true } },
      _count: { select: { orders: true, ticketTiers: { where: { deletedAt: null } } } },
    },
  });
  if (!event) throw eventNotFound();
  const capabilities = eventCapabilities(event, event._count.ticketTiers, event._count.orders);
  const [cancellationJob, refundCounts] = await Promise.all([
    event.status === 'CANCELLED'
      ? getPrisma().job.findUnique({
          where: { deduplicationKey: `event-cancellation:${event.id}` },
          select: { status: true, completedAt: true },
        })
      : null,
    event.status === 'CANCELLED'
      ? getPrisma().refund.groupBy({ by: ['status'], where: { order: { eventId } }, _count: true })
      : [],
  ]);
  return {
    ...event,
    capabilities,
    setupChecks: capabilities.setupChecks,
    checkInWindow: capabilities.checkInWindow,
    cancellationState: {
      cancelledAt: event.cancelledAt,
      dispatchStatus: cancellationJob?.status ?? null,
      dispatchCompletedAt: cancellationJob?.completedAt ?? null,
      refundsByStatus: Object.fromEntries(refundCounts.map((row) => [row.status, row._count])),
    },
    serverTime: new Date(),
  };
};

export const createEvent = async (actorId: string, input: CreateEventInput) => {
  if (input.startAt <= new Date()) throw invalidDate('Event must start in the future');
  const event = await getPrisma().$transaction(async (tx) => {
    const event = await tx.event.create({
      data: { ...input, imageUrl: input.imageUrl ?? null, organizerId: actorId },
    });
    await tx.auditLog.create({
      data: { actorId, action: 'EVENT_CREATED', entityType: 'EVENT', entityId: event.id },
    });
    return event;
  });
  await invalidatePublicDiscoveryCache();
  return event;
};

export const updateEvent = async (actor: Actor, eventId: string, input: UpdateEventInput) => {
  const event = await findOwnedEvent(eventId, actor);
  if (!eventCapabilities(event, 0, 0).editable) {
    throw conflict(
      'INVALID_EVENT_TRANSITION',
      'Event cannot be edited',
      'Only draft and published events can be edited.',
    );
  }
  const lockedFields = ['startAt', 'endAt', 'venue', 'city', 'address', 'category'] as const;
  if (event.status === EventStatus.PUBLISHED && lockedFields.some((field) => field in input)) {
    throw conflict(
      'PUBLISHED_EVENT_FIELD_LOCKED',
      'Published event location and dates cannot change',
      'Only title, description, and image may change after publishing.',
    );
  }

  const startAt = input.startAt ?? event.startAt;
  const endAt = input.endAt ?? event.endAt;
  if (endAt <= startAt) throw invalidDate('End time must be after start time');
  if (event.status === EventStatus.DRAFT && startAt <= new Date()) {
    throw invalidDate('Event must start in the future');
  }

  const data = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Prisma.EventUpdateInput;
  const updated = await serializableTransaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "Event" WHERE "id" = ${eventId}::uuid FOR UPDATE`,
    );
    const current = await findOwnedEvent(eventId, actor, tx);
    const capabilities = eventCapabilities(current, 0, 0);
    if (
      !capabilities.editable ||
      Object.keys(data).some((field) => !capabilities.editableFields.includes(field))
    )
      throw conflict(
        'INVALID_EVENT_TRANSITION',
        'Event fields cannot be edited',
        'Event lifecycle changed; reload its capabilities.',
      );
    const currentStart = input.startAt ?? current.startAt;
    if (
      (input.endAt ?? current.endAt) <= currentStart ||
      (current.status === 'DRAFT' && currentStart <= new Date())
    )
      throw invalidDate('Event dates are no longer valid.');
    const updated = await tx.event.update({ where: { id: event.id }, data });
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        action: 'EVENT_UPDATED',
        entityType: 'EVENT',
        entityId: event.id,
        metadata: { fields: Object.keys(data) },
      },
    });
    return updated;
  });
  await invalidatePublicDiscoveryCache();
  return updated;
};

export const softDeleteEvent = async (actor: Actor, eventId: string) => {
  const event = await findOwnedEvent(eventId, actor);
  if (!eventCapabilities(event, 0, 0).canDelete) {
    throw conflict(
      'INVALID_EVENT_TRANSITION',
      'Only draft events may be deleted',
      'Cancel published events instead.',
    );
  }
  await getPrisma().$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "Event" WHERE "id" = ${eventId}::uuid FOR UPDATE`,
    );
    const current = await findOwnedEvent(eventId, actor, tx);
    const orderCount = await tx.order.count({ where: { eventId: event.id } });
    if (!eventCapabilities(current, 0, orderCount).canDelete) {
      throw conflict(
        'EVENT_HAS_ORDERS',
        'Event with orders cannot be deleted',
        'Historical orders must be retained.',
      );
    }
    await tx.event.update({ where: { id: event.id }, data: { deletedAt: new Date() } });
    await tx.auditLog.create({
      data: { actorId: actor.id, action: 'EVENT_DELETED', entityType: 'EVENT', entityId: event.id },
    });
  });
  await invalidatePublicDiscoveryCache();
};

export const publishEvent = async (actor: Actor, eventId: string) => {
  const event = await findOwnedEvent(eventId, actor);
  if (!eventCapabilities(event, 1, 0).canPublish) {
    throw conflict(
      'INVALID_EVENT_TRANSITION',
      'Event cannot be published',
      'Event must be a future draft.',
    );
  }
  const updated = await serializableTransaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "Event" WHERE "id" = ${eventId}::uuid FOR UPDATE`,
    );
    const current = await findOwnedEvent(eventId, actor, tx);
    const activeTierCount = await tx.ticketTier.count({
      where: { eventId: event.id, deletedAt: null },
    });
    if (!eventCapabilities(current, activeTierCount, 0).canPublish) {
      throw conflict(
        'NO_ACTIVE_TICKET_TIERS',
        'Event needs an active ticket tier',
        'Create a ticket tier first.',
      );
    }
    const updated = await tx.event.update({
      where: { id: event.id },
      data: { status: EventStatus.PUBLISHED, publishedAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        action: 'EVENT_PUBLISHED',
        entityType: 'EVENT',
        entityId: event.id,
      },
    });
    return updated;
  });
  await invalidatePublicDiscoveryCache();
  return updated;
};

export const cancelEvent = async (actor: Actor, eventId: string) => {
  const event = await findOwnedEvent(eventId, actor);
  if (!eventCapabilities(event, 0, 0).canCancel) {
    throw conflict(
      'INVALID_EVENT_TRANSITION',
      'Event cannot be cancelled',
      'Only upcoming draft or published events can be cancelled.',
    );
  }
  const updated = await serializableTransaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "Event" WHERE "id" = ${eventId}::uuid FOR UPDATE`,
    );
    const current = await tx.event.findUniqueOrThrow({ where: { id: eventId } });
    if (!eventCapabilities(current, 0, 0).canCancel)
      throw conflict(
        'INVALID_EVENT_TRANSITION',
        'Event cannot be cancelled',
        'Only upcoming draft or published events can be cancelled.',
      );
    const updated = await tx.event.update({
      where: { id: event.id },
      data: { status: EventStatus.CANCELLED, cancelledAt: new Date() },
    });
    await tx.ticket.updateMany({
      where: { eventId: event.id, status: { in: ['ACTIVE', 'CHECKED_IN'] } },
      data: { status: 'VOIDED' },
    });
    await tx.job.upsert({
      where: { deduplicationKey: `event-cancellation:${event.id}` },
      update: {},
      create: {
        type: 'PROCESS_EVENT_CANCELLATION',
        deduplicationKey: `event-cancellation:${event.id}`,
        payload: { eventId: event.id },
        runAt: new Date(),
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        action: 'EVENT_CANCELLED',
        entityType: 'EVENT',
        entityId: event.id,
      },
    });
    return updated;
  });
  await invalidatePublicDiscoveryCache();
  return updated;
};
