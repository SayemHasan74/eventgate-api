import { z } from 'zod';

export const ticketTierIdParamsSchema = z
  .object({ eventId: z.string().uuid(), tierId: z.string().uuid() })
  .strict();

const ticketTierFields = {
  name: z.string().trim().min(2).max(100),
  pricePaisa: z.number().int().min(1),
  capacity: z.number().int().min(1),
  salesStartAt: z.coerce.date(),
  salesEndAt: z.coerce.date(),
};

export const createTicketTierSchema = z
  .object(ticketTierFields)
  .strict()
  .refine((tier) => tier.salesEndAt > tier.salesStartAt, {
    path: ['salesEndAt'],
    message: 'Sales end must be after sales start',
  });

export const updateTicketTierSchema = z.object(ticketTierFields).partial().strict();

export type CreateTicketTierInput = z.infer<typeof createTicketTierSchema>;
export type UpdateTicketTierInput = z.infer<typeof updateTicketTierSchema>;
