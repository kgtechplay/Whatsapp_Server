import { Router } from 'express';
import type { AppConfig } from '../../config/env.js';
import { asyncHandler } from '../../shared/utils/async-handler.js';
import { createSessionController } from '../controllers/session.controller.js';
import { createApiKeyAuth } from '../middleware/api-key-auth.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import type { ConnectionManager } from '../../core/whatsapp/connection-manager.js';

export interface SessionRouteOptions {
  config: AppConfig;
  connection: ConnectionManager;
  isAccepting?: () => boolean;
  rateLimit?: {
    windowMs: number;
    max: number;
  };
}

export function createSessionRouter(options: SessionRouteOptions): Router {
  const router = Router();
  const controller = createSessionController(options.connection);
  const limit = options.rateLimit ?? { windowMs: 60_000, max: 30 };

  router.use((_req, res, next) => {
    if (options.isAccepting && !options.isAccepting()) {
      res.status(503).json({
        error: 'shutting_down',
        message: 'Service is shutting down',
      });
      return;
    }
    next();
  });
  router.use(createRateLimiter(limit));
  router.use(createApiKeyAuth(options.config.apiKey));

  router.get('/status', asyncHandler(controller.status));
  router.get('/qr', asyncHandler(controller.qr));
  router.post('/connect', asyncHandler(controller.connect));
  router.post('/logout', asyncHandler(controller.logout));

  return router;
}
