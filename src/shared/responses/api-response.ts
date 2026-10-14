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

const redactMessage = (value: string): string =>
  value.replace(/https?:\/\/[^\s<>"']+/gi, '[provider address]').slice(0, 1000);
const safeDiagnostics = (value: unknown): unknown => {
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(safeDiagnostics);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === 'failureMessage' && typeof item === 'string'
          ? redactMessage(item)
          : safeDiagnostics(item),
      ]),
    );
  return value;
};

export const sendSuccess = <T>(
  response: Response,
  status: number,
  message: string,
  data: T,
): Response<SuccessBody<T>> =>
  response.status(status).json({ success: true, message, data: safeDiagnostics(data) });

export const sendList = <T>(
  response: Response,
  message: string,
  data: T[],
  meta: PaginationMeta,
  summary?: Record<string, number>,
): Response<ListBody<T>> =>
  response.status(200).json({
    success: true,
    message,
    data: safeDiagnostics(data),
    meta: { page: meta.page, limit: meta.limit, total: meta.total, totalPages: meta.totalPages },
    ...(summary ? { summary } : {}),
  });

export const sendError = (
  response: Response,
  status: number,
  message: string,
  errors: ErrorDetail[] = [],
): Response<ErrorBody> =>
  response.status(status).json({
    success: false,
    message: redactMessage(message),
    errors: errors.map((error) => ({ ...error, message: redactMessage(error.message) })),
  });
