import { z } from 'zod';

export const eventSlugParamsSchema = z.object({ slug: z.string().min(1).max(200) }).strict();

export const discoveryQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().min(1).max(120).optional(),
    category: z.string().trim().min(1).max(80).optional(),
    city: z.string().trim().min(1).max(100).optional(),
    startAfter: z.coerce.date().optional(),
    startBefore: z.coerce.date().optional(),
    sort: z.enum(['soonest', 'latest', 'newest', 'title']).default('soonest'),
  })
  .strict()
  .refine(
    (query) => !query.startAfter || !query.startBefore || query.startAfter <= query.startBefore,
    {
      path: ['startBefore'],
      message: 'Start-before must be after start-after',
    },
  );

export type DiscoveryQuery = z.infer<typeof discoveryQuerySchema>;
