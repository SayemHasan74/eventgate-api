import type { ErrorDetail } from '../responses/api-response.js';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly errors: ErrorDetail[];
  public readonly isOperational: boolean;

  public constructor({
    statusCode,
    code,
    message,
    errors = [],
    cause,
  }: {
    statusCode: number;
    code: string;
    message: string;
    errors?: ErrorDetail[];
    cause?: unknown;
  }) {
    super(message, { cause });
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.errors = errors;
    this.isOperational = true;
  }
}

export const isAppError = (error: unknown): error is AppError => error instanceof AppError;
