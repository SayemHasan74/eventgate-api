import { OrderStatus } from '../../generated/prisma/client.js';
import { z } from 'zod';
import { listFields, dateFields, validDateRange } from '../../shared/responses/read-contracts.js';

export const createOrderSchema = z
  .object({ ticketTierId: z.string().uuid(), quantity: z.number().int().min(1).max(10) })
  .strict();

export const orderIdParamsSchema = z.object({ orderId: z.string().uuid() }).strict();

export const orderListQuerySchema = z
  .object({
    ...listFields,
    ...dateFields,
    status: z.nativeEnum(OrderStatus).optional(),
  })
  .strict()
  .refine(validDateRange, { path: ['startBefore'], message: 'End must be after start.' });

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type OrderListQuery = z.infer<typeof orderListQuerySchema>;
