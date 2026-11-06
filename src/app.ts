import express from 'express';
import type { Express } from 'express';
import type { AppConfig } from './config/env.js';
import type { AppLogger } from './config/logger.js';
import { createErrorHandler } from './api/middleware/error-handler.js';
import { createHealthRouter } from './api/routes/health.routes.js';
import { createMessageRouter } from './api/routes/message.routes.js';
import { createSessionRouter } from './api/routes/session.routes.js';
import { IdempotencyStore } from './core/messaging/idempotency-store.js';
import { MessageSender } from './core/messaging/message-sender.js';
import { SendCoordinator } from './core/messaging/send-coordinator.js';
import type { ConnectionManager } from './core/whatsapp/connection-manager.js';
import type { ConnectionStatusService } from './core/whatsapp/connection-status.js';

export class AcceptGate {
  private accepting = true;

  close(): void {
    this.accepting = false;
  }

  isAccepting(): boolean {
    return this.accepting;
  }
}

export interface AppDependencies {
  config: AppConfig;
  logger: AppLogger;
  status: ConnectionStatusService;
  connection: ConnectionManager;
  gate?: AcceptGate;
  messageSender?: MessageSender;
  rateLimit?: {
    windowMs: number;
    max: number;
  };
}

export function createApp(deps: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  if (deps.config.nodeEnv === 'production') {
    app.set('trust proxy', 1);
  }
  app.use(express.json({ limit: '64kb' }));

  const gate = deps.gate;
  const messageSender = deps.messageSender ?? createMessageSender(deps);
  app.use(createHealthRouter(deps.status));
  app.use(
    '/api/session',
    createSessionRouter({
      config: deps.config,
      connection: deps.connection,
      ...(gate ? { isAccepting: () => gate.isAccepting() } : {}),
      ...(deps.rateLimit ? { rateLimit: deps.rateLimit } : {}),
    }),
  );
  app.use(
    '/api/messages',
    createMessageRouter({
      config: deps.config,
      sender: messageSender,
      logger: deps.logger,
      ...(gate ? { isAccepting: () => gate.isAccepting() } : {}),
    }),
  );

  app.use((_req, res) => {
    res.status(404).json({
      error: 'not_found',
      message: 'Route not found',
    });
  });
  app.use(createErrorHandler(deps.logger));

  return app;
}

function createMessageSender(deps: AppDependencies): MessageSender {
  return new MessageSender({
    connection: deps.connection,
    config: deps.config.messaging,
    logger: deps.logger,
    coordinator: new SendCoordinator({
      delayMs: deps.config.messaging.sendDelayMs,
      maxRequestsPerMinute: deps.config.messaging.maxSendRequestsPerMinute,
      maxMessagesPerHour: deps.config.messaging.maxOutboundMessagesPerHour,
    }),
    idempotency: new IdempotencyStore(deps.config.messaging.idempotencyTtlMs),
  });
}
