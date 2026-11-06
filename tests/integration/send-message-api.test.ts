import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { IdempotencyStore } from '../../src/core/messaging/idempotency-store.js';
import { MessageSender } from '../../src/core/messaging/message-sender.js';
import type { MessagingConfig, OutboundConnection } from '../../src/core/messaging/messaging.types.js';
import { SendCoordinator } from '../../src/core/messaging/send-coordinator.js';
import { TEST_API_KEY, createHarness, testConfig } from '../helpers/harness.js';

const MESSAGE = 'Hello from my WhatsApp Gateway!';

describe('send message API', () => {
  it('sends one and several recipients for an authorized caller', async () => {
    const context = createContext();
    const single = await request(context.app)
      .post('/api/messages/send')
      .set(auth())
      .send({ recipients: ['+919876543210'], message: MESSAGE });
    expect(single.status).toBe(200);
    expect(single.body.summary).toEqual({ total: 1, sent: 1, failed: 0, notSent: 0, unknown: 0 });
    expect(single.body.results[0]).toMatchObject({ number: '919876543210', status: 'sent', messageId: 'mid-1' });

    const many = await request(context.app)
      .post('/api/messages/send')
      .set(auth())
      .send({ recipients: ['919876543210', '14155552671', '447911123456'], message: MESSAGE });
    expect(many.status).toBe(200);
    expect(many.body.summary.sent).toBe(3);
    expect(context.calls).toEqual([
      '919876543210@s.whatsapp.net',
      '919876543210@s.whatsapp.net',
      '14155552671@s.whatsapp.net',
      '447911123456@s.whatsapp.net',
    ]);
    expect(context.logger.text()).not.toContain(MESSAGE);
    expect(context.logger.text()).not.toContain(TEST_API_KEY);
    expect(context.logger.text()).not.toContain('919876543210');
  });

  it('rejects invalid requests before sending', async () => {
    const context = createContext();
    const malformed = await request(context.app)
      .post('/api/messages/send')
      .set(auth())
      .set('Content-Type', 'application/json')
      .send('{"recipients":');
    expect(malformed.status).toBe(400);

    const badNumber = await request(context.app)
      .post('/api/messages/send')
      .set(auth())
      .send({ recipients: ['9876543210'], message: MESSAGE });
    expect(badNumber.status).toBe(400);
    expect(badNumber.body.error.code).toBe('INVALID_RECIPIENT');

    const empty = await request(context.app)
      .post('/api/messages/send')
      .set(auth())
      .send({ recipients: ['919876543210'], message: ' ' });
    expect(empty.status).toBe(400);

    const duplicates = await request(context.app)
      .post('/api/messages/send')
      .set(auth())
      .send({ recipients: ['+919876543210', '919876543210'], message: MESSAGE });
    expect(duplicates.status).toBe(400);

    const tooMany = await request(context.app)
      .post('/api/messages/send')
      .set(auth())
      .send({
        recipients: Array.from({ length: 11 }, () => '919876543210'),
        message: MESSAGE,
      });
    expect(tooMany.status).toBe(400);
    expect(context.calls).toEqual([]);
  });

  it('requires the API key and a connected session', async () => {
    const context = createContext();
    const missing = await request(context.app).post('/api/messages/send').send({ recipients: ['919876543210'], message: MESSAGE });
    expect(missing.status).toBe(401);

    context.connected = false;
    const disconnected = await request(context.app)
      .post('/api/messages/send')
      .set(auth())
      .send({ recipients: ['919876543210'], message: MESSAGE });
    expect(disconnected.status).toBe(503);
    expect(disconnected.body.error.code).toBe('WHATSAPP_DISCONNECTED');
    expect(context.calls).toEqual([]);
  });

  it('enforces the allowlist and the send quota', async () => {
    const restricted = createContext({
      allowAllRecipients: false,
      allowedRecipients: ['919876543210'],
    });
    const denied = await request(restricted.app)
      .post('/api/messages/send')
      .set(auth())
      .send({ recipients: ['14155552671'], message: MESSAGE });
    expect(denied.status).toBe(400);
    expect(denied.body.error.code).toBe('RECIPIENT_NOT_ALLOWED');
    expect(restricted.calls).toEqual([]);

    const limited = createContext({ maxSendRequestsPerMinute: 1 });
    const first = await request(limited.app)
      .post('/api/messages/send')
      .set(auth())
      .send({ recipients: ['919876543210'], message: MESSAGE });
    expect(first.status).toBe(200);
    const second = await request(limited.app)
      .post('/api/messages/send')
      .set(auth())
      .send({ recipients: ['919876543210'], message: MESSAGE });
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(limited.calls).toHaveLength(1);
  });

  it('replays a completed idempotent request and rejects conflicts', async () => {
    const context = createContext();
    const payload = { recipients: ['919876543210'], message: MESSAGE };
    const first = await request(context.app).post('/api/messages/send').set(auth()).set('Idempotency-Key', 'order-1001').send(payload);
    expect(first.status).toBe(200);
    const replay = await request(context.app).post('/api/messages/send').set(auth()).set('Idempotency-Key', 'order-1001').send(payload);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(context.calls).toHaveLength(1);

    const conflict = await request(context.app)
      .post('/api/messages/send')
      .set(auth())
      .set('Idempotency-Key', 'order-1001')
      .send({ recipients: ['14155552671'], message: MESSAGE });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');

    let release: (value: { messageId: string | null }) => void = () => undefined;
    context.connection.sendText = (jid) => {
      context.calls.push(jid);
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const running = request(context.app)
      .post('/api/messages/send')
      .set(auth())
      .set('Idempotency-Key', 'order-1002')
      .send(payload);
    void running.then(
      () => undefined,
      () => undefined,
    );
    await waitFor(() => context.calls.length === 2);
    const inProgress = await request(context.app)
      .post('/api/messages/send')
      .set(auth())
      .set('Idempotency-Key', 'order-1002')
      .send(payload);
    expect(inProgress.status).toBe(409);
    expect(inProgress.body.error.code).toBe('REQUEST_IN_PROGRESS');
    release({ messageId: 'mid-later' });
    expect((await running).status).toBe(200);
  });
});

function auth(): { Authorization: string } {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

function createContext(options?: {
  allowAllRecipients?: boolean;
  allowedRecipients?: string[];
  maxSendRequestsPerMinute?: number;
  maxRecipientsPerRequest?: number;
}) {
  const harness = createHarness();
  const calls: string[] = [];
  const state = { connected: true };
  const messaging: MessagingConfig = {
    ...testConfig().messaging,
    allowAllRecipients: options?.allowAllRecipients ?? true,
    allowedRecipients: options?.allowedRecipients ?? [],
    maxSendRequestsPerMinute: options?.maxSendRequestsPerMinute ?? 10,
    maxRecipientsPerRequest: options?.maxRecipientsPerRequest ?? 10,
    sendDelayMs: 0,
  };
  const connection: OutboundConnection = {
    isConnected: () => state.connected,
    getStatus: () => ({ status: state.connected ? 'CONNECTED' : 'DISCONNECTED' }),
    async sendText(jid) {
      calls.push(jid);
      return { messageId: `mid-${calls.length}` };
    },
  };
  const sender = new MessageSender({
    connection,
    config: messaging,
    logger: harness.logger,
    coordinator: new SendCoordinator({
      delayMs: 0,
      maxRequestsPerMinute: messaging.maxSendRequestsPerMinute,
      maxMessagesPerHour: messaging.maxOutboundMessagesPerHour,
      sleep: async () => undefined,
    }),
    idempotency: new IdempotencyStore(messaging.idempotencyTtlMs),
  });
  const config = testConfig({ messaging });
  const app = createApp({
    config,
    logger: harness.logger,
    status: harness.status,
    connection: harness.manager,
    messageSender: sender,
  });
  return {
    app,
    calls,
    logger: harness.logger,
    connection,
    get connected() {
      return state.connected;
    },
    set connected(value: boolean) {
      state.connected = value;
    },
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 2000) {
      throw new Error('timed out waiting for send');
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}
