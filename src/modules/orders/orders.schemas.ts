import { OrderStatus } from '../../generated/prisma/client.js';
import { z } from 'zod';

export const createOrderSchema = z
  .object({ ticketTierId: z.string().uuid(), quantity: z.number().int().min(1).max(10) })
  .strict();

export const orderIdParamsSchema = z.object({ orderId: z.string().uuid() }).strict();

export const orderListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z.nativeEnum(OrderStatus).optional(),
  })
  .strict();

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type OrderListQuery = z.infer<typeof orderListQuerySchema>;
