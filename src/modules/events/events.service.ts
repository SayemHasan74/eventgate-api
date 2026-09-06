import { EventStatus, type Prisma, UserRole } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';

import type { CreateEventInput, UpdateEventInput } from './events.schemas.js';

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

export const findOwnedEvent = async (eventId: string, actor: Actor) => {
  const event = await getPrisma().event.findFirst({
    where: {
      id: eventId,
      deletedAt: null,
      ...(actor.role === UserRole.ADMIN ? {} : { organizerId: actor.id }),
    },
  });
  if (!event) throw eventNotFound();
  return event;
};

export const listManagedEvents = (actor: Actor) =>
  getPrisma().event.findMany({
    where:
      actor.role === UserRole.ADMIN
        ? { deletedAt: null }
        : { organizerId: actor.id, deletedAt: null },
    orderBy: { createdAt: 'desc' },
  });

export const createEvent = async (actorId: string, input: CreateEventInput) => {
  if (input.startAt <= new Date()) throw invalidDate('Event must start in the future');
  return getPrisma().$transaction(async (tx) => {
    const event = await tx.event.create({
      data: { ...input, imageUrl: input.imageUrl ?? null, organizerId: actorId },
    });
    await tx.auditLog.create({
      data: { actorId, action: 'EVENT_CREATED', entityType: 'EVENT', entityId: event.id },
    });
    return event;
  });
};

export const updateEvent = async (actor: Actor, eventId: string, input: UpdateEventInput) => {
  const event = await findOwnedEvent(eventId, actor);
  if (event.status !== EventStatus.DRAFT && event.status !== EventStatus.PUBLISHED) {
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
  return getPrisma().$transaction(async (tx) => {
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
};

export const softDeleteEvent = async (actor: Actor, eventId: string) => {
  const event = await findOwnedEvent(eventId, actor);
  if (event.status !== EventStatus.DRAFT) {
    throw conflict(
      'INVALID_EVENT_TRANSITION',
      'Only draft events may be deleted',
      'Cancel published events instead.',
    );
  }
  return getPrisma().$transaction(async (tx) => {
    const orderCount = await tx.order.count({ where: { eventId: event.id } });
    if (orderCount > 0) {
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
};

export const publishEvent = async (actor: Actor, eventId: string) => {
  const event = await findOwnedEvent(eventId, actor);
  if (event.status !== EventStatus.DRAFT || event.startAt <= new Date()) {
    throw conflict(
      'INVALID_EVENT_TRANSITION',
      'Event cannot be published',
      'Event must be a future draft.',
    );
  }
  return getPrisma().$transaction(async (tx) => {
    const activeTierCount = await tx.ticketTier.count({
      where: { eventId: event.id, deletedAt: null },
    });
    if (activeTierCount === 0) {
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
};

export const cancelEvent = async (actor: Actor, eventId: string) => {
  const event = await findOwnedEvent(eventId, actor);
  if (
    (event.status !== EventStatus.DRAFT && event.status !== EventStatus.PUBLISHED) ||
    event.startAt <= new Date()
  ) {
    throw conflict(
      'INVALID_EVENT_TRANSITION',
      'Event cannot be cancelled',
      'Only upcoming draft or published events can be cancelled.',
    );
  }
  return getPrisma().$transaction(async (tx) => {
    const updated = await tx.event.update({
      where: { id: event.id },
      data: { status: EventStatus.CANCELLED, cancelledAt: new Date() },
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
};
