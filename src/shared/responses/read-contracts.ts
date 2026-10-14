import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
export const emptyQuerySchema = z.object({}).strict();
export const emptyCommandSchema = z.object({}).strict().default({});

export const listFields = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().min(1).max(120).optional(),
};
export const dateFields = {
  startAfter: z.coerce.date().optional(),
  startBefore: z.coerce.date().optional(),
};
export const validDateRange = (query: {
  startAfter?: Date | undefined;
  startBefore?: Date | undefined;
}) => !query.startAfter || !query.startBefore || query.startBefore > query.startAfter;
export const dateRange = (query: {
  startAfter?: Date | undefined;
  startBefore?: Date | undefined;
}) => ({
  ...(query.startAfter ? { gte: query.startAfter } : {}),
  ...(query.startBefore ? { lt: query.startBefore } : {}),
});
export const eventSummarySelect = {
  id: true,
  title: true,
  slug: true,
  status: true,
  venue: true,
  city: true,
  startAt: true,
  endAt: true,
  deletedAt: true,
} satisfies Prisma.EventSelect;
export const publicEventSelect = {
  id: true,
  isDemo: true,
  title: true,
  slug: true,
  description: true,
  category: true,
  venue: true,
  city: true,
  address: true,
  startAt: true,
  endAt: true,
  imageUrl: true,
  status: true,
  createdAt: true,
  organizer: { select: { id: true, displayName: true } },
} satisfies Prisma.EventSelect;
export const paymentSummarySelect = {
  id: true,
  orderId: true,
  merchantTransactionId: true,
  amountPaisa: true,
  currency: true,
  status: true,
  initiatedAt: true,
  completedAt: true,
  failureCode: true,
  failureMessage: true,
} satisfies Prisma.PaymentAttemptSelect;
export const refundSummarySelect = {
  id: true,
  orderId: true,
  paymentAttemptId: true,
  requestedById: true,
  reviewedById: true,
  processedAt: true,
  amountPaisa: true,
  currency: true,
  reason: true,
  status: true,
  requestedAt: true,
  reviewedAt: true,
  completedAt: true,
  userMessage: true,
  reviewerNote: true,
  requestCount: true,
  needsInvestigation: true,
  failureCode: true,
  failureMessage: true,
  activities: {
    select: { id: true, action: true, note: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.RefundSelect;
