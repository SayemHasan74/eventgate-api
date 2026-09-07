import { z } from 'zod';

export const orderIdParamsSchema = z.object({ orderId: z.string().uuid() }).strict();
export const refundIdParamsSchema = z.object({ refundId: z.string().uuid() }).strict();
export const reviewRefundSchema = z.object({ decision: z.enum(['approve', 'reject']) }).strict();
export type ReviewRefundInput = z.infer<typeof reviewRefundSchema>;
