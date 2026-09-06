import { z } from 'zod';

import { UserRole, UserStatus } from '../../generated/prisma/client.js';

export const profileSchema = z.object({ displayName: z.string().trim().min(2).max(120) }).strict();

export const userIdParamsSchema = z.object({ userId: z.string().uuid() }).strict();

// This deliberately excludes ADMIN. Administrator accounts are seed-only and cannot
// be created, promoted, or demoted through the public administration API.
export const userRoleSchema = z
  .object({ role: z.enum([UserRole.ATTENDEE, UserRole.ORGANIZER]) })
  .strict();

export const userStatusSchema = z
  .object({ status: z.enum([UserStatus.ACTIVE, UserStatus.SUSPENDED]) })
  .strict();

export const userListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    role: z.nativeEnum(UserRole).optional(),
    status: z.nativeEnum(UserStatus).optional(),
    search: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export type ProfileInput = z.infer<typeof profileSchema>;
export type UserListQuery = z.infer<typeof userListQuerySchema>;
