import { z } from 'zod';

export const aiQuestionSchema = z.object({ question: z.string().trim().min(3).max(500) }).strict();
export const eventQuestionSchema = aiQuestionSchema
  .extend({
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(200),
  })
  .strict();
const day = z.iso.date().nullable();
export const searchIntentSchema = z
  .object({
    relevant: z.boolean(),
    search: z.string().trim().max(120).nullable(),
    city: z.string().trim().max(100).nullable(),
    category: z.string().trim().max(80).nullable(),
    startDate: day,
    endDate: day,
    maxPricePaisa: z.number().int().min(0).max(100_000_000).nullable(),
  })
  .strict()
  .refine(
    (value) => !value.startDate || !value.endDate || value.startDate <= value.endDate,
    'Invalid date range',
  );
export const sourceSelectionSchema = z
  .object({ sourceIds: z.array(z.string().max(60)).max(4) })
  .strict();
