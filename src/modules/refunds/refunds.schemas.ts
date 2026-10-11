import { z } from 'zod';

export const orderIdParamsSchema = z.object({ orderId: z.string().uuid() }).strict();
export const refundIdParamsSchema = z.object({ refundId: z.string().uuid() }).strict();
export const requestRefundSchema = z
  .object({ userMessage: z.string().trim().min(1).max(1000).optional() })
  .strict()
  .default({});
export const reviewRefundSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    reviewerNote: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()
  .refine((input) => input.decision !== 'reject' || Boolean(input.reviewerNote), {
    path: ['reviewerNote'],
    message: 'A rejection reason is required.',
  });
export type ReviewRefundInput = z.infer<typeof reviewRefundSchema>;
