import type { Response } from 'express';

export type ErrorDetail = {
  field?: string;
  code: string;
  message: string;
};

export type PaginationMeta = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

type SuccessBody<T> = {
  success: true;
  message: string;
  data: T;
};

type ListBody<T> = SuccessBody<T[]> & {
  meta: PaginationMeta;
};

type ErrorBody = {
  success: false;
  message: string;
  errors: ErrorDetail[];
};

export const sendSuccess = <T>(
  response: Response,
  status: number,
  message: string,
  data: T,
): Response<SuccessBody<T>> => response.status(status).json({ success: true, message, data });

export const sendList = <T>(
  response: Response,
  message: string,
  data: T[],
  meta: PaginationMeta,
): Response<ListBody<T>> => response.status(200).json({ success: true, message, data, meta });

export const sendError = (
  response: Response,
  status: number,
  message: string,
  errors: ErrorDetail[] = [],
): Response<ErrorBody> => response.status(status).json({ success: false, message, errors });
