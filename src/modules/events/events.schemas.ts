import { z } from 'zod';

export const eventIdParamsSchema = z.object({ eventId: z.string().uuid() }).strict();

const eventFields = {
  title: z.string().trim().min(3).max(180),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(200),
  description: z.string().trim().min(20),
  category: z.string().trim().min(2).max(80),
  venue: z.string().trim().min(2).max(160),
  city: z.string().trim().min(2).max(100),
  address: z.string().trim().min(5),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  imageUrl: z.string().url().startsWith('https://').nullable().optional(),
};

export const createEventSchema = z
  .object(eventFields)
  .strict()
  .refine((event) => event.endAt > event.startAt, {
    path: ['endAt'],
    message: 'End time must be after start time',
  });

export const updateEventSchema = z.object(eventFields).partial().omit({ slug: true }).strict();

export type CreateEventInput = z.infer<typeof createEventSchema>;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;
