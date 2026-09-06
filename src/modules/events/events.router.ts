import { Router } from 'express';
import { z } from 'zod';
import { EventStatus, type Prisma, UserRole } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { AppError } from '../../shared/errors/app-error.js';
import { sendSuccess } from '../../shared/responses/api-response.js';

const eventInput = z
  .object({
    title: z.string().trim().min(3).max(180),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(200),
    description: z.string().trim().min(20),
    category: z.string().trim().min(2).max(80),
    venue: z.string().trim().min(2).max(160),
    city: z.string().trim().min(2).max(100),
    address: z.string().trim().min(5),
    startAt: z.coerce.date(),
    endAt: z.coerce.date(),
    imageUrl: z.string().url().startsWith('https://').optional(),
  })
  .strict()
  .refine((v) => v.endAt > v.startAt, {
    message: 'End time must be after start time',
    path: ['endAt'],
  });
const eventPatch = eventInput.partial().omit({ slug: true }).strict();
const idSchema = z.object({ eventId: z.string().uuid() }).strict();
const eventsRouter = Router();
eventsRouter.use(authenticate, authorize(UserRole.ORGANIZER, UserRole.ADMIN));
const owned = async (id: string, actor: Express.Request['auth']) => {
  const e = await getPrisma().event.findFirst({
    where: {
      id,
      deletedAt: null,
      ...(actor.role === UserRole.ADMIN ? {} : { organizerId: actor.id }),
    },
  });
  if (!e)
    throw new AppError({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Event not found',
      errors: [{ code: 'NOT_FOUND', message: 'Event not found.' }],
    });
  return e;
};
eventsRouter.get('/', async (r, s) =>
  sendSuccess(
    s,
    200,
    'Organizer events retrieved',
    await getPrisma().event.findMany({
      where:
        r.auth.role === UserRole.ADMIN
          ? { deletedAt: null }
          : { organizerId: r.auth.id, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    }),
  ),
);
eventsRouter.post('/', validate({ body: eventInput }), async (r, s) => {
  const input = r.body as z.infer<typeof eventInput>;
  if (input.startAt <= new Date())
    throw new AppError({
      statusCode: 400,
      code: 'INVALID_EVENT_DATE',
      message: 'Event must start in the future',
      errors: [
        {
          field: 'body.startAt',
          code: 'INVALID_EVENT_DATE',
          message: 'Choose a future start time.',
        },
      ],
    });
  const db = getPrisma();
  const e = await db.$transaction(async (tx) => {
    const x = await tx.event.create({
      data: { ...input, imageUrl: input.imageUrl ?? null, organizerId: r.auth.id },
    });
    await tx.auditLog.create({
      data: { actorId: r.auth.id, action: 'EVENT_CREATED', entityType: 'EVENT', entityId: x.id },
    });
    return x;
  });
  sendSuccess(s, 201, 'Event created', e);
});
eventsRouter.patch('/:eventId', validate({ params: idSchema, body: eventPatch }), async (r, s) => {
  const e = await owned(r.params.eventId as string, r.auth);
  const input = r.body as z.infer<typeof eventPatch>;
  if (
    e.status !== EventStatus.DRAFT &&
    (['startAt', 'endAt', 'venue', 'city', 'address'] as const).some((k) => k in input)
  )
    throw new AppError({
      statusCode: 409,
      code: 'PUBLISHED_EVENT_FIELD_LOCKED',
      message: 'Published event location and dates cannot change',
      errors: [
        {
          code: 'PUBLISHED_EVENT_FIELD_LOCKED',
          message: 'Only title, description, and image may change after publishing.',
        },
      ],
    });
  const data = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Prisma.EventUpdateInput;
  const updated = await getPrisma().event.update({ where: { id: e.id }, data });
  sendSuccess(s, 200, 'Event updated', updated);
});
eventsRouter.delete('/:eventId', validate({ params: idSchema }), async (r, s) => {
  const e = await owned(r.params.eventId as string, r.auth);
  const db = getPrisma();
  if (e.status !== EventStatus.DRAFT)
    throw new AppError({
      statusCode: 409,
      code: 'INVALID_EVENT_TRANSITION',
      message: 'Only draft events may be deleted',
      errors: [{ code: 'INVALID_EVENT_TRANSITION', message: 'Cancel published events instead.' }],
    });
  if (await db.order.count({ where: { eventId: e.id } }))
    throw new AppError({
      statusCode: 409,
      code: 'EVENT_HAS_ORDERS',
      message: 'Event with orders cannot be deleted',
      errors: [{ code: 'EVENT_HAS_ORDERS', message: 'Historical orders must be retained.' }],
    });
  await db.event.update({ where: { id: e.id }, data: { deletedAt: new Date() } });
  sendSuccess(s, 200, 'Event deleted', null);
});
eventsRouter.post('/:eventId/publish', validate({ params: idSchema }), async (r, s) => {
  const e = await owned(r.params.eventId as string, r.auth);
  const db = getPrisma();
  if (e.status !== EventStatus.DRAFT || e.startAt <= new Date())
    throw new AppError({
      statusCode: 409,
      code: 'INVALID_EVENT_TRANSITION',
      message: 'Event cannot be published',
      errors: [{ code: 'INVALID_EVENT_TRANSITION', message: 'Event must be a future draft.' }],
    });
  if (!(await db.ticketTier.count({ where: { eventId: e.id, deletedAt: null } })))
    throw new AppError({
      statusCode: 409,
      code: 'NO_ACTIVE_TICKET_TIERS',
      message: 'Event needs an active ticket tier',
      errors: [{ code: 'NO_ACTIVE_TICKET_TIERS', message: 'Create a ticket tier first.' }],
    });
  const updated = await db.event.update({
    where: { id: e.id },
    data: { status: EventStatus.PUBLISHED, publishedAt: new Date() },
  });
  sendSuccess(s, 200, 'Event published', updated);
});
eventsRouter.post('/:eventId/cancel', validate({ params: idSchema }), async (r, s) => {
  const e = await owned(r.params.eventId as string, r.auth);
  if (e.status === EventStatus.CANCELLED || e.startAt <= new Date())
    throw new AppError({
      statusCode: 409,
      code: 'INVALID_EVENT_TRANSITION',
      message: 'Event cannot be cancelled',
      errors: [
        { code: 'INVALID_EVENT_TRANSITION', message: 'Only upcoming events can be cancelled.' },
      ],
    });
  const db = getPrisma();
  const updated = await db.$transaction(async (tx) => {
    const x = await tx.event.update({
      where: { id: e.id },
      data: { status: EventStatus.CANCELLED, cancelledAt: new Date() },
    });
    await tx.job.upsert({
      where: { deduplicationKey: `event-cancellation:${e.id}` },
      update: {},
      create: {
        type: 'PROCESS_EVENT_CANCELLATION',
        deduplicationKey: `event-cancellation:${e.id}`,
        payload: { eventId: e.id },
        runAt: new Date(),
      },
    });
    await tx.auditLog.create({
      data: { actorId: r.auth.id, action: 'EVENT_CANCELLED', entityType: 'EVENT', entityId: e.id },
    });
    return x;
  });
  sendSuccess(s, 200, 'Event cancellation scheduled', updated);
});
export { eventsRouter };
