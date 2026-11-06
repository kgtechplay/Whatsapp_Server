import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { createApp, AcceptGate } from './app.js';
import { loadConfig } from './config/env.js';
import type { AppConfig } from './config/env.js';
import { createLogger } from './config/logger.js';
import type { AppLogger } from './config/logger.js';
import { createBaileysSocketFactory } from './core/whatsapp/baileys-socket.js';
import { ConnectionManager } from './core/whatsapp/connection-manager.js';
import { ConnectionStatusService } from './core/whatsapp/connection-status.js';
import { DEFAULT_JITTER_RATIO, DEFAULT_RECONNECT_MULTIPLIER } from './core/whatsapp/reconnect-policy.js';
import { FileSessionStore } from './core/whatsapp/session-store.js';
import type { SessionStore } from './core/whatsapp/session-store.js';
import type { SocketFactory } from './core/whatsapp/baileys-socket.js';

export interface RunningApplication {
  config: AppConfig;
  logger: AppLogger;
  server: http.Server;
  manager: ConnectionManager;
  gate: AcceptGate;
  shutdown: (exit?: (code: number) => void) => Promise<void>;
}

export interface StartOverrides {
  sessionStore?: SessionStore;
  socketFactory?: SocketFactory;
  listen?: boolean;
}

export async function startApplication(
  env: NodeJS.ProcessEnv,
  overrides: StartOverrides = {},
): Promise<RunningApplication> {
  const config = loadConfig(env);
  const logger = createLogger({
    level: config.logLevel,
    secrets: [config.apiKey],
  });
  logger.info(
    {
      event: 'app.startup',
      connectionState: 'INITIALIZING',
    },
    'Application starting',
  );
  logger.info(
    {
      event: 'config.validated',
      connectionState: 'INITIALIZING',
      nodeEnv: config.nodeEnv,
      port: config.port,
      autoReconnect: config.autoReconnect,
      logLevel: config.logLevel,
      authPath: path.resolve(config.whatsappAuthPath),
    },
    'Configuration validated',
  );

  const status = new ConnectionStatusService();
  const sessionStore = overrides.sessionStore ?? new FileSessionStore(config.whatsappAuthPath, logger);
  const socketFactory = overrides.socketFactory ?? createBaileysSocketFactory(logger.baileys());
  const manager = new ConnectionManager({
    config,
    logger,
    status,
    sessionStore,
    socketFactory,
    policy: {
      initialDelayMs: config.reconnectInitialDelayMs,
      maxDelayMs: config.reconnectMaxDelayMs,
      multiplier: DEFAULT_RECONNECT_MULTIPLIER,
      jitterRatio: DEFAULT_JITTER_RATIO,
    },
  });
  const gate = new AcceptGate();
  const app = createApp({ config, logger, status, connection: manager, gate });
  const server = http.createServer(app);

  if (overrides.listen !== false) {
    await listen(server, config.port);
    logger.info(
      {
        event: 'http.listening',
        connectionState: status.snapshot().status,
        port: config.port,
      },
      'HTTP server listening',
    );
  }

  void manager.start().catch((error: unknown) => {
    logger.error(
      {
        event: 'app.unrecoverable',
        connectionState: 'ERROR',
        errorCategory: 'startup',
        err: error,
      },
      'WhatsApp manager failed during startup',
    );
  });

  let shutdownStarted = false;
  const shutdown = async (exit: (code: number) => void = process.exit): Promise<void> => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    gate.close();

    const timeout = setTimeout(() => {
      logger.error(
        {
          event: 'app.shutdown.timeout',
          connectionState: safeState(manager),
        },
        'Shutdown timed out',
      );
      exit(1);
    }, config.shutdownTimeoutMs);

    try {
      await manager.shutdown();
      await closeServer(server);
      logger.info(
        {
          event: 'app.shutdown',
          connectionState: safeState(manager),
        },
        'Application shutdown complete',
      );
      clearTimeout(timeout);
      exit(0);
    } catch (error) {
      clearTimeout(timeout);
      logger.error(
        {
          event: 'app.unrecoverable',
          connectionState: safeState(manager),
          errorCategory: 'shutdown',
          err: error,
        },
        'Shutdown failed',
      );
      exit(1);
    }
  };

  return { config, logger, server, manager, gate, shutdown };
}

export function registerSignalHandlers(app: RunningApplication, exit?: (code: number) => void): () => void {
  const onSignal = (signal: NodeJS.Signals): void => {
    app.logger.info(
      {
        event: 'app.shutdown',
        connectionState: safeState(app.manager),
        signal,
      },
      'Shutdown signal received',
    );
    void app.shutdown(exit);
  };

  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
}

function safeState(manager: ConnectionManager): string {
  try {
    return manager.getStatus().status;
  } catch {
    return 'ERROR';
  }
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once('error', onError);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function main(): Promise<void> {
  dotenv.config({ override: false });
  try {
    const running = await startApplication(process.env);
    registerSignalHandlers(running);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Startup failed';
    console.error(message);
    process.exit(1);
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entry) {
  void main();
}
