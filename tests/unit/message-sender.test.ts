import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSessionStore } from '../../src/core/whatsapp/session-store.js';
import { IdempotencyStore } from '../../src/core/messaging/idempotency-store.js';
import { MessageSender } from '../../src/core/messaging/message-sender.js';
import type { MessagingConfig, OutboundConnection } from '../../src/core/messaging/messaging.types.js';
import { IDEMPOTENCY_TTL_MS } from '../../src/core/messaging/messaging.types.js';
import { SendCoordinator } from '../../src/core/messaging/send-coordinator.js';
import { toWhatsAppJid } from '../../src/core/messaging/recipient-validator.js';
import { createMemoryLogger } from '../helpers/memory-logger.js';
import { createHarness, emitOpen } from '../helpers/harness.js';

const directories: string[] = [];

const messaging: MessagingConfig = {
  maxRecipientsPerRequest: 10,
  maxMessageLength: 4000,
  sendDelayMs: 0,
  maxSendRequestsPerMinute: 10,
  maxOutboundMessagesPerHour: 30,
  sendTimeoutMs: 30,
  allowAllRecipients: true,
  allowedRecipients: [],
  idempotencyTtlMs: IDEMPOTENCY_TTL_MS,
};

describe('message sender', () => {
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('sends to one recipient through the existing connection and returns the message id', async () => {
    const harness = createHarness({ registered: true });
    await harness.manager.start();
    const socket = harness.sockets[0];
    if (!socket) {
      throw new Error('missing socket');
    }
    socket.sendMessage = vi.fn(async () => ({ key: { id: 'BAILEYS_MESSAGE_ID' } }));
    emitOpen(socket);

    const result = await harness.manager.sendText(toWhatsAppJid('919876543210'), 'Hello');
    expect(result).toEqual({ messageId: 'BAILEYS_MESSAGE_ID' });
    expect(harness.factory.create).toHaveBeenCalledTimes(1);
    expect(socket.logout).not.toHaveBeenCalled();
    expect(harness.store.invalidate).not.toHaveBeenCalled();
  });

  it('sends to three recipients sequentially and continues after one failure', async () => {
    const calls: string[] = [];
    const connection = fakeConnection({
      async sendText(jid) {
        calls.push(jid);
        if (jid.startsWith('14155552671')) {
          throw new Error('rejected');
        }
        return { messageId: `mid-${calls.length}` };
      },
    });
    const { sender } = createSender(connection);
    const result = await sender.send({
      recipients: ['919876543210', '14155552671', '447911123456'],
      message: 'Hello from my WhatsApp Gateway!',
    });

    expect(calls).toEqual([
      '919876543210@s.whatsapp.net',
      '14155552671@s.whatsapp.net',
      '447911123456@s.whatsapp.net',
    ]);
    expect(result.body.summary).toEqual({ total: 3, sent: 2, failed: 1, notSent: 0, unknown: 0 });
    expect(result.body.results[1]).toMatchObject({ status: 'failed', errorCode: 'SEND_FAILED' });
    expect(result.body.results[2]).toMatchObject({ status: 'sent' });
  });

  it('marks recipients that were not started after the connection drops', async () => {
    let connected = true;
    const calls: string[] = [];
    const connection = fakeConnection({
      isConnected: () => connected,
      async sendText(jid) {
        calls.push(jid);
        connected = false;
        return { messageId: 'mid-1' };
      },
    });
    const { sender } = createSender(connection);
    const result = await sender.send({
      recipients: ['919876543210', '14155552671', '447911123456'],
      message: 'Hello',
    });
    expect(calls).toEqual(['919876543210@s.whatsapp.net']);
    expect(result.body.results.map((item) => item.status)).toEqual(['sent', 'not_sent', 'not_sent']);
  });

  it('records an unknown result on timeout and does not send again for that attempt', async () => {
    let release: (value: { messageId: string | null }) => void = () => undefined;
    const calls: string[] = [];
    const connection = fakeConnection({
      async sendText(jid) {
        calls.push(jid);
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const { sender } = createSender(connection, { ...messaging, sendTimeoutMs: 20 });
    const result = await sender.send({
      recipients: ['919876543210', '14155552671'],
      message: 'Hello secret body',
    });
    expect(result.body.results.map((item) => item.status)).toEqual(['unknown', 'not_sent']);
    expect(result.body.results[0]).toMatchObject({ errorCode: 'SEND_TIMEOUT' });
    expect(calls).toEqual(['919876543210@s.whatsapp.net']);

    await expect(
      sender.send({
        recipients: ['919876543210'],
        message: 'Hello secret body',
      }),
    ).rejects.toMatchObject({ statusCode: 503, errorCode: 'SEND_TIMEOUT' });
    expect(calls).toEqual(['919876543210@s.whatsapp.net']);
    release({ messageId: 'late-id' });
  });

  it('does not invent a message id when Baileys omits one', async () => {
    const connection = fakeConnection({
      async sendText() {
        return { messageId: null };
      },
    });
    const { sender, logger } = createSender(connection);
    const result = await sender.send({
      recipients: ['919876543210'],
      message: 'Hello secret body',
    });
    expect(result.body.results[0]).toMatchObject({ status: 'unknown', errorCode: 'SEND_FAILED' });
    expect(JSON.stringify(result.body)).not.toContain('messageId');
    expect(logger.text()).not.toContain('Hello secret body');
    expect(logger.text()).not.toContain('919876543210');
    expect(logger.text()).toContain('***3210');
  });

  it('leaves saved authentication untouched', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'wa-send-auth-'));
    directories.push(directory);
    const logger = createMemoryLogger();
    const store = new FileSessionStore(directory, logger);
    const first = await store.load();
    if (!first.state.creds) {
      throw new Error('missing creds');
    }
    first.state.creds.registered = true;
    first.state.creds.me = { id: '919876543210:1@s.whatsapp.net', name: 'My WhatsApp' };
    await first.saveCreds();

    const { sender } = createSender(fakeConnection());
    await sender.send({ recipients: ['14155552671'], message: 'Hello' });

    const second = await store.load();
    expect(second.registered).toBe(true);
    expect(second.state.creds?.me?.id).toContain('919876543210');
  });
});

function fakeConnection(overrides: Partial<OutboundConnection> = {}): OutboundConnection {
  return {
    isConnected: () => true,
    getStatus: () => ({ status: 'CONNECTED' }),
    async sendText() {
      return { messageId: 'mid-1' };
    },
    ...overrides,
  };
}

function createSender(connection: OutboundConnection, config: MessagingConfig = messaging) {
  const logger = createMemoryLogger();
  const sender = new MessageSender({
    connection,
    config,
    logger,
    coordinator: new SendCoordinator({
      delayMs: config.sendDelayMs,
      maxRequestsPerMinute: config.maxSendRequestsPerMinute,
      maxMessagesPerHour: config.maxOutboundMessagesPerHour,
      sleep: async () => undefined,
    }),
    idempotency: new IdempotencyStore(config.idempotencyTtlMs),
  });
  return { sender, logger };
}
