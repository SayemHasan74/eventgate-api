import { z } from 'zod';

export const ticketIdParamsSchema = z.object({ ticketId: z.string().uuid() }).strict();
export const eventIdParamsSchema = z.object({ eventId: z.string().uuid() }).strict();

export const checkInSchema = z.object({ qrToken: z.string().min(40).max(128) }).strict();

export const checkInHistoryQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type CheckInInput = z.infer<typeof checkInSchema>;
export type CheckInHistoryQuery = z.infer<typeof checkInHistoryQuerySchema>;
