import type { RequestHandler } from 'express';

import { sendList, sendSuccess } from '../../shared/responses/api-response.js';

import type { ProfileInput, UserListQuery } from './users.schemas.js';
import {
  changeUserRole,
  changeUserStatus,
  getProfile,
  listUsers,
  softDeleteUser,
  updateProfile,
} from './users.service.js';

export const readProfile: RequestHandler = async (request, response) => {
  sendSuccess(response, 200, 'Profile retrieved', await getProfile(request.auth.id));
};

export const editProfile: RequestHandler = async (request, response) => {
  sendSuccess(
    response,
    200,
    'Profile updated',
    await updateProfile(request.auth.id, request.body as ProfileInput),
  );
};

export const readUsers: RequestHandler = async (request, response) => {
  const result = await listUsers(request.query as unknown as UserListQuery);
  sendList(response, 'Users retrieved', result.users, {
    page: result.page,
    limit: result.limit,
    total: result.total,
    totalPages: Math.ceil(result.total / result.limit),
  });
};

export const editUserRole: RequestHandler = async (request, response) => {
  const user = await changeUserRole(
    request.auth.id,
    request.params.userId as string,
    request.body.role,
  );
  sendSuccess(response, 200, 'User role updated', user);
};

export const editUserStatus: RequestHandler = async (request, response) => {
  const user = await changeUserStatus(
    request.auth.id,
    request.params.userId as string,
    request.body.status,
  );
  sendSuccess(response, 200, 'User status updated', user);
};

export const removeUser: RequestHandler = async (request, response) => {
  await softDeleteUser(request.auth.id, request.params.userId as string);
  sendSuccess(response, 200, 'User deleted', null);
};
