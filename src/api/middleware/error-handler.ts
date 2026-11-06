import type { NextFunction, Request, Response } from 'express';
import type { AppLogger } from '../../config/logger.js';
import { AppError } from '../../shared/errors/app-error.js';

export function createErrorHandler(logger: AppLogger) {
  return function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
    if (res.headersSent) {
      return;
    }

    if (isPayloadTooLarge(error)) {
      res.status(413).json({
        success: false,
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Request payload is too large.',
        },
      });
      return;
    }

    if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
      res.status(400).json({
        error: 'bad_request',
        message: 'Request body must be valid JSON.',
      });
      return;
    }

    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        error: error.code,
        message: error.message,
      });
      return;
    }

    logger.error(
      {
        event: 'http.unhandled',
        connectionState: 'ERROR',
        errorCategory: 'http',
        err: error,
      },
      'Unhandled HTTP error',
    );
    res.status(500).json({
      error: 'internal_error',
      message: 'Internal server error',
    });
  };
}

function isPayloadTooLarge(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { type?: unknown; status?: unknown };
  return candidate.type === 'entity.too.large' || candidate.status === 413;
}
