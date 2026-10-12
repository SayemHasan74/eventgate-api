import { z } from 'zod';
import { TicketStatus } from '../../generated/prisma/client.js';
import { listFields } from '../../shared/responses/read-contracts.js';
export const ticketListQuerySchema = z
  .object({
    ...listFields,
    status: z.nativeEnum(TicketStatus).optional(),
    period: z.enum(['upcoming', 'past', 'all']).default('all'),
    orderId: z.string().uuid().optional(),
  })
  .strict();
export type TicketListQuery = z.infer<typeof ticketListQuerySchema>;

export const ticketIdParamsSchema = z.object({ ticketId: z.string().uuid() }).strict();
export const eventIdParamsSchema = z.object({ eventId: z.string().uuid() }).strict();

export const checkInSchema = z
  .object({
    qrToken: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{43}$/, 'Provide the opaque EventGate QR token, not a URL.'),
  })
  .strict();

export const checkInHistoryQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    search: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export type CheckInInput = z.infer<typeof checkInSchema>;
export type CheckInHistoryQuery = z.infer<typeof checkInHistoryQuerySchema>;
