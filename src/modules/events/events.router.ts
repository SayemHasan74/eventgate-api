import { Router } from 'express';
import { z } from 'zod';
import { EventStatus, UserRole } from '../../generated/prisma/client.js';
import { getPrisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { AppError } from '../../shared/errors/app-error.js';
import { sendSuccess } from '../../shared/responses/api-response.js';

import {
  addEvent,
  editEvent,
  publishManagedEvent,
  readManagedEvents,
  removeEvent,
  requestEventCancellation,
} from './events.controller.js';
import { createEventSchema, eventIdParamsSchema, updateEventSchema } from './events.schemas.js';
import { findOwnedEvent } from './events.service.js';

const tierParams = z.object({ eventId: z.string().uuid(), tierId: z.string().uuid() }).strict();
const tierInput = z
  .object({
    name: z.string().trim().min(2).max(100),
    pricePaisa: z.number().int().min(1),
    capacity: z.number().int().min(1),
    salesStartAt: z.coerce.date(),
    salesEndAt: z.coerce.date(),
  })
  .strict()
  .refine((v) => v.salesEndAt > v.salesStartAt, {
    path: ['salesEndAt'],
    message: 'Sales end must be after sales start',
  });
const eventsRouter = Router();
eventsRouter.use(authenticate, authorize(UserRole.ORGANIZER, UserRole.ADMIN));
eventsRouter.get('/', readManagedEvents);
eventsRouter.post('/', validate({ body: createEventSchema }), addEvent);
eventsRouter.patch(
  '/:eventId',
  validate({ params: eventIdParamsSchema, body: updateEventSchema }),
  editEvent,
);
eventsRouter.delete('/:eventId', validate({ params: eventIdParamsSchema }), removeEvent);
eventsRouter.post(
  '/:eventId/publish',
  validate({ params: eventIdParamsSchema }),
  publishManagedEvent,
);
eventsRouter.post(
  '/:eventId/cancel',
  validate({ params: eventIdParamsSchema }),
  requestEventCancellation,
);
eventsRouter.post(
  '/:eventId/ticket-tiers',
  validate({ params: eventIdParamsSchema, body: tierInput }),
  async (r, s) => {
    const e = await findOwnedEvent(r.params.eventId as string, r.auth);
    if (e.status !== EventStatus.DRAFT)
      throw new AppError({
        statusCode: 409,
        code: 'INVALID_EVENT_TRANSITION',
        message: 'Ticket tiers can only be added to drafts',
        errors: [{ code: 'INVALID_EVENT_TRANSITION', message: 'Event is not a draft.' }],
      });
    const input = r.body as z.infer<typeof tierInput>;
    if (input.salesStartAt < new Date() || input.salesEndAt > e.startAt)
      throw new AppError({
        statusCode: 400,
        code: 'INVALID_SALES_WINDOW',
        message: 'Invalid sales window',
        errors: [
          { code: 'INVALID_SALES_WINDOW', message: 'Sales must end before the event starts.' },
        ],
      });
    const tier = await getPrisma().ticketTier.create({ data: { ...input, eventId: e.id } });
    sendSuccess(s, 201, 'Ticket tier created', tier);
  },
);
eventsRouter.patch(
  '/:eventId/ticket-tiers/:tierId',
  validate({ params: tierParams, body: tierInput.partial().strict() }),
  async (r, s) => {
    const e = await findOwnedEvent(r.params.eventId as string, r.auth);
    const db = getPrisma();
    const tier = await db.ticketTier.findFirst({
      where: { id: r.params.tierId as string, eventId: e.id, deletedAt: null },
    });
    if (!tier)
      throw new AppError({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: 'Ticket tier not found',
        errors: [{ code: 'NOT_FOUND', message: 'Ticket tier not found.' }],
      });
    const input = r.body as Partial<z.infer<typeof tierInput>>;
    if (
      input.pricePaisa !== undefined &&
      (await db.order.count({ where: { ticketTierId: tier.id } }))
    )
      throw new AppError({
        statusCode: 409,
        code: 'PRICE_LOCKED',
        message: 'Ticket price is locked',
        errors: [{ code: 'PRICE_LOCKED', message: 'Tier has order history.' }],
      });
    if (input.capacity !== undefined && input.capacity < tier.reservedQuantity + tier.soldQuantity)
      throw new AppError({
        statusCode: 409,
        code: 'CAPACITY_TOO_LOW',
        message: 'Capacity is below reserved and sold tickets',
        errors: [{ code: 'CAPACITY_TOO_LOW', message: 'Capacity cannot invalidate inventory.' }],
      });
    const data = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    sendSuccess(
      s,
      200,
      'Ticket tier updated',
      await db.ticketTier.update({ where: { id: tier.id }, data }),
    );
  },
);
eventsRouter.delete(
  '/:eventId/ticket-tiers/:tierId',
  validate({ params: tierParams }),
  async (r, s) => {
    const e = await findOwnedEvent(r.params.eventId as string, r.auth);
    const db = getPrisma();
    const tier = await db.ticketTier.findFirst({
      where: { id: r.params.tierId as string, eventId: e.id, deletedAt: null },
    });
    if (!tier)
      throw new AppError({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: 'Ticket tier not found',
        errors: [{ code: 'NOT_FOUND', message: 'Ticket tier not found.' }],
      });
    if (await db.order.count({ where: { ticketTierId: tier.id } }))
      throw new AppError({
        statusCode: 409,
        code: 'TIER_HAS_ORDERS',
        message: 'Ticket tier has order history',
        errors: [{ code: 'TIER_HAS_ORDERS', message: 'Close sales instead of deleting.' }],
      });
    await db.ticketTier.update({ where: { id: tier.id }, data: { deletedAt: new Date() } });
    sendSuccess(s, 200, 'Ticket tier deleted', null);
  },
);
export { eventsRouter };
