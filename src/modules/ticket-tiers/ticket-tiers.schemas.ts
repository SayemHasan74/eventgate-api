import { z } from 'zod';

export const ticketTierIdParamsSchema = z
  .object({ eventId: z.string().uuid(), tierId: z.string().uuid() })
  .strict();

const ticketTierFields = {
  name: z.string().trim().min(2).max(100),
  pricePaisa: z.number().int().min(1).max(2147483647),
  capacity: z.number().int().min(1).max(2147483647),
  salesStartAt: z.coerce.date(),
  salesEndAt: z.coerce.date(),
  salesPaused: z.boolean().optional(),
};

export const createTicketTierSchema = z
  .object(ticketTierFields)
  .strict()
  .refine((tier) => tier.salesEndAt > tier.salesStartAt, {
    path: ['salesEndAt'],
    message: 'Sales end must be after sales start',
  });

export const updateTicketTierSchema = z
  .object(ticketTierFields)
  .partial()
  .extend({ closeSales: z.literal(true).optional() })
  .strict()
  .refine(
    (value) =>
      Object.keys(value).length > 0 && (!value.closeSales || Object.keys(value).length === 1),
    { message: 'Supply changed fields, or closeSales alone.' },
  );

export type CreateTicketTierInput = z.infer<typeof createTicketTierSchema>;
export type UpdateTicketTierInput = z.infer<typeof updateTicketTierSchema>;
