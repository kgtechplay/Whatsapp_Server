import { Router } from 'express';
import type { AppConfig } from '../../config/env.js';
import type { AppLogger } from '../../config/logger.js';
import { asyncHandler } from '../../shared/utils/async-handler.js';
import type { MessageSender } from '../../core/messaging/message-sender.js';
import { createMessageController } from '../controllers/message.controller.js';
import { createApiKeyAuth } from '../middleware/api-key-auth.js';

export function createMessageRouter(options: {
  config: AppConfig;
  sender: MessageSender;
  logger: AppLogger;
  isAccepting?: () => boolean;
}): Router {
  const router = Router();
  const controller = createMessageController(options.sender, options.config.messaging, options.logger);

  router.use((_req, res, next) => {
    if (options.isAccepting && !options.isAccepting()) {
      res.status(503).json({
        success: false,
        error: {
          code: 'WHATSAPP_DISCONNECTED',
          message: 'Service is shutting down',
        },
      });
      return;
    }
    next();
  });
  router.use(createApiKeyAuth(options.config.apiKey));
  router.post('/send', asyncHandler(controller.send));
  return router;
}
