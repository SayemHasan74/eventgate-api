import { z } from 'zod';
import { dateFields, validDateRange } from '../../shared/responses/read-contracts.js';

export const auditLogQuerySchema = z
  .object({
    action: z.string().trim().min(1).max(160).optional(),
    entityType: z.string().trim().min(1).max(80).optional(),
    actorId: z.string().uuid().optional(),
    entityId: z.string().uuid().optional(),
    ...dateFields,
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine(validDateRange, { path: ['startBefore'], message: 'End must be after start.' });

export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;
