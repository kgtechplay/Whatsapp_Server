import { vi } from 'vitest';
import type { AppConfig } from '../../src/config/env.js';
import { IDEMPOTENCY_TTL_MS } from '../../src/core/messaging/messaging.types.js';
import type { WaSocketLike } from '../../src/core/whatsapp/baileys-socket.js';
import { ConnectionManager } from '../../src/core/whatsapp/connection-manager.js';
import { ConnectionStatusService } from '../../src/core/whatsapp/connection-status.js';
import { createMemoryLogger } from './memory-logger.js';
import type { MemoryLogger } from './memory-logger.js';

export const TEST_API_KEY = 'test-api-key-value-1';
export const QR_PAYLOAD = 'qr-payload-do-not-log';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: 'test',
    port: 3000,
    whatsappAuthPath: './data/baileys-auth',
    autoReconnect: true,
    reconnectInitialDelayMs: 2000,
    reconnectMaxDelayMs: 60_000,
    apiKey: TEST_API_KEY,
    logLevel: 'silent',
    shutdownTimeoutMs: 1000,
    messaging: {
      maxRecipientsPerRequest: 10,
      maxMessageLength: 4000,
      sendDelayMs: 0,
      maxSendRequestsPerMinute: 10,
      maxOutboundMessagesPerHour: 30,
      sendTimeoutMs: 30_000,
      allowAllRecipients: false,
      allowedRecipients: [],
      idempotencyTtlMs: IDEMPOTENCY_TTL_MS,
    },
    ...overrides,
  };
}

type Listener = (payload: never) => void;

export class FakeSocket implements WaSocketLike {
  user?: WaSocketLike['user'];
  readonly listeners = new Map<string, Listener[]>();
  readonly logout = vi.fn(async (): Promise<void> => {
    this.emit('connection.update', {
      connection: 'close',
      lastDisconnect: {
        error: disconnectError(401),
        date: new Date(),
      },
    });
  });
  readonly end = vi.fn();
  sendMessage?: WaSocketLike['sendMessage'];

  readonly ev = {
    on: (event: 'connection.update' | 'creds.update', listener: Listener): void => {
      const current = this.listeners.get(event) ?? [];
      current.push(listener);
      this.listeners.set(event, current);
    },
  };

  emit(event: string, payload?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload as never);
    }
  }
}

export function disconnectError(statusCode: number): Error & { output: { statusCode: number } } {
  const error = new Error(`connection closed ${statusCode}`) as Error & { output: { statusCode: number } };
  error.output = { statusCode };
  return error;
}

export function emitOpen(
  socket: FakeSocket,
  user: NonNullable<WaSocketLike['user']> = { id: '919876543210:4@s.whatsapp.net', name: 'My WhatsApp' },
): void {
  socket.user = user;
  socket.emit('connection.update', { connection: 'open' });
}

export function emitClose(socket: FakeSocket, statusCode: number): void {
  socket.emit('connection.update', {
    connection: 'close',
    lastDisconnect: {
      error: disconnectError(statusCode),
      date: new Date(),
    },
  });
}

export interface HarnessOptions {
  registered?: boolean;
  autoReconnect?: boolean;
  loadError?: Error;
  random?: () => number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

export function createHarness(options: HarnessOptions = {}) {
  const sockets: FakeSocket[] = [];
  const saveCreds = vi.fn(async () => undefined);
  const state = {
    creds: {
      registered: options.registered ?? false,
      me: undefined as { id?: string; name?: string } | undefined,
    },
    keys: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => undefined),
    },
  };
  const store = {
    load: vi.fn(async () => {
      if (options.loadError) {
        throw options.loadError;
      }
      return {
        state,
        saveCreds,
        registered: state.creds.registered === true,
      };
    }),
    invalidate: vi.fn(async () => {
      state.creds.registered = false;
    }),
  };
  const factory = {
    create: vi.fn(async () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    }),
  };
  const status = new ConnectionStatusService();
  const logger: MemoryLogger = createMemoryLogger();
  const config = testConfig({
    autoReconnect: options.autoReconnect ?? true,
    reconnectInitialDelayMs: options.initialDelayMs ?? 2000,
    reconnectMaxDelayMs: options.maxDelayMs ?? 60_000,
  });
  const manager = new ConnectionManager({
    config,
    logger,
    status,
    sessionStore: store,
    socketFactory: factory,
    policy: {
      initialDelayMs: config.reconnectInitialDelayMs,
      maxDelayMs: config.reconnectMaxDelayMs,
      multiplier: 2,
      jitterRatio: 0.2,
    },
    random: options.random ?? (() => 0.5),
  });

  return { sockets, saveCreds, store, factory, status, logger, config, manager, state };
}
