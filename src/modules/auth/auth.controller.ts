import type { Request, Response } from 'express';

import { sendSuccess } from '../../shared/responses/api-response.js';
import { googleTokenVerifier } from '../../integrations/google/google-token-verifier.js';
import { loginWithGoogle, linkGoogleIdentity } from './google-auth.service.js';
import { login, logout, refresh, register } from './auth.service.js';
import type { LoginInput, RegisterInput } from './auth.schemas.js';

export const registerController = async (request: Request, response: Response): Promise<void> => {
  const result = await register(request.body as RegisterInput);
  sendSuccess(response, 201, 'Account registered', result);
};

export const loginController = async (request: Request, response: Response): Promise<void> => {
  const result = await login(request.body as LoginInput);
  sendSuccess(response, 200, 'Signed in', result);
};

export const refreshController = async (request: Request, response: Response): Promise<void> => {
  const result = await refresh((request.body as { refreshToken: string }).refreshToken);
  sendSuccess(response, 200, 'Session refreshed', result);
};

export const logoutController = async (request: Request, response: Response): Promise<void> => {
  await logout((request.body as { refreshToken: string }).refreshToken);
  sendSuccess(response, 200, 'Signed out', null);
};

export const googleLoginController = async (
  request: Request,
  response: Response,
): Promise<void> => {
  const identity = await googleTokenVerifier.verify((request.body as { idToken: string }).idToken);
  const result = await loginWithGoogle(identity);
  sendSuccess(response, 200, 'Signed in with Google', result);
};

export const googleLinkController = async (request: Request, response: Response): Promise<void> => {
  const identity = await googleTokenVerifier.verify((request.body as { idToken: string }).idToken);
  const result = await linkGoogleIdentity(request.auth, identity);
  sendSuccess(
    response,
    200,
    result.alreadyLinked ? 'Google account is already linked' : 'Google account linked',
    result,
  );
};
