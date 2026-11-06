import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { ConnectionStatusService } from '../../src/core/whatsapp/connection-status.js';
import { registerSignalHandlers, startApplication } from '../../src/server.js';
import { FakeSocket, QR_PAYLOAD, TEST_API_KEY, createHarness, emitClose, emitOpen } from '../helpers/harness.js';
import { DisconnectCode } from '../../src/core/whatsapp/reconnect-policy.js';

function auth(key = TEST_API_KEY): { Authorization: string } {
  return { Authorization: `Bearer ${key}` };
}

describe('session API', () => {
  it('serves health without WhatsApp and rejects missing credentials (TC-008)', async () => {
    const harness = createHarness();
    const app = createApp({
      config: harness.config,
      logger: harness.logger,
      status: harness.status,
      connection: harness.manager,
    });

    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ status: 'ok', service: 'whatsapp-gateway' });
    expect(health.body.uptimeSeconds).toEqual(expect.any(Number));
    expect(JSON.stringify(health.body)).not.toContain(TEST_API_KEY);

    const missing = await request(app).get('/api/session/status');
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual({ error: 'unauthorized', message: 'Missing or invalid API key' });

    const wrong = await request(app).get('/api/session/status').set(auth('not-the-real-api-key'));
    expect(wrong.status).toBe(401);
    expect(JSON.stringify(wrong.body)).not.toContain('not-the-real-api-key');

    const ok = await request(app).get('/api/session/status').set(auth());
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'INITIALIZING', connected: false, account: null });
  });

  it('returns 503 when the status manager is unavailable', async () => {
    const harness = createHarness();
    const status = new ConnectionStatusService();
    status.markUnavailable();
    const app = createApp({
      config: harness.config,
      logger: harness.logger,
      status,
      connection: harness.manager,
    });

    const health = await request(app).get('/health');
    expect(health.status).toBe(503);
    expect(health.body.status).toBe('unavailable');
  });

  it('returns the QR only while pairing and blocks it after connect (TC-001, TC-009)', async () => {
    const harness = createHarness();
    const app = createApp({
      config: harness.config,
      logger: harness.logger,
      status: harness.status,
      connection: harness.manager,
    });
    await harness.manager.start();

    const pending = await request(app).get('/api/session/qr').set(auth());
    expect(pending.status).toBe(404);

    harness.sockets[0]?.emit('connection.update', { qr: QR_PAYLOAD });
    const ready = await request(app).get('/api/session/qr').set(auth());
    expect(ready.status).toBe(200);
    expect(ready.headers['cache-control']).toBe('no-store');
    expect(ready.body).toEqual({ status: 'QR_REQUIRED', qr: QR_PAYLOAD, expiresAt: null });
    expect(harness.logger.text()).not.toContain(QR_PAYLOAD);

    emitOpen(required(harness.sockets[0]));
    const connected = await request(app).get('/api/session/qr').set(auth());
    expect(connected.status).toBe(409);
    const status = await request(app).get('/api/session/status').set(auth());
    expect(status.body).toMatchObject({
      status: 'CONNECTED',
      connected: true,
      account: { id: '919876543210', name: 'My WhatsApp' },
    });
  });

  it('is idempotent when connect is repeated and reports reconnecting status (TC-007, TC-013, TC-015)', async () => {
    const harness = createHarness({ registered: true });
    const app = createApp({
      config: harness.config,
      logger: harness.logger,
      status: harness.status,
      connection: harness.manager,
    });

    let release: (socket: FakeSocket) => void = () => undefined;
    const gate = new Promise<FakeSocket>((resolve) => {
      release = resolve;
    });
    harness.factory.create.mockImplementation(async () => gate);

    const pending = Promise.all([
      request(app).post('/api/session/connect').set(auth()),
      request(app).post('/api/session/connect').set(auth()),
      request(app).post('/api/session/connect').set(auth()),
    ]);
    const socket = new FakeSocket();
    release(socket);
    const responses = await pending;
    const codes = responses.map((response) => response.status).sort();
    expect(codes).toEqual([200, 200, 202]);
    expect(harness.factory.create).toHaveBeenCalledTimes(1);

    emitOpen(socket);
    const again = await request(app).post('/api/session/connect').set(auth());
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ success: true, status: 'CONNECTED', message: 'Connection already active' });

    emitClose(socket, DisconnectCode.connectionClosed);
    const duringRetry = await request(app).get('/api/session/status').set(auth());
    expect(duringRetry.status).toBe(200);
    expect(duringRetry.body).toMatchObject({
      status: 'RECONNECTING',
      connected: false,
      reconnectAttempts: 1,
      lastError: { category: 'network' },
    });
  });

  it('logs out through the API and then allows a new pairing attempt', async () => {
    const harness = createHarness({ registered: true });
    const app = createApp({
      config: harness.config,
      logger: harness.logger,
      status: harness.status,
      connection: harness.manager,
    });
    await harness.manager.start();
    emitOpen(required(harness.sockets[0]));

    const logout = await request(app).post('/api/session/logout').set(auth());
    expect(logout.status).toBe(200);
    expect(logout.body).toEqual({ success: true, status: 'LOGGED_OUT' });
    expect(harness.store.invalidate).toHaveBeenCalledTimes(1);

    const connect = await request(app).post('/api/session/connect').set(auth());
    expect(connect.status).toBe(202);
    expect(harness.factory.create).toHaveBeenCalledTimes(2);
  });

  it('rate limits protected session routes', async () => {
    const harness = createHarness();
    const app = createApp({
      config: harness.config,
      logger: harness.logger,
      status: harness.status,
      connection: harness.manager,
      rateLimit: { windowMs: 60_000, max: 2 },
    });

    expect((await request(app).get('/api/session/status').set(auth())).status).toBe(200);
    expect((await request(app).get('/api/session/status').set(auth())).status).toBe(200);
    const limited = await request(app).get('/api/session/status').set(auth());
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeTruthy();
  });

  it('closes the process on SIGTERM without logging out (TC-011)', async () => {
    const harness = createHarness({ registered: true, autoReconnect: false });
    const running = await startApplication(
      {
        NODE_ENV: 'test',
        PORT: '3210',
        WHATSAPP_AUTH_PATH: './data/baileys-auth',
        API_KEY: TEST_API_KEY,
        AUTO_RECONNECT: 'false',
        LOG_LEVEL: 'silent',
        RECONNECT_INITIAL_DELAY_MS: '2000',
        RECONNECT_MAX_DELAY_MS: '60000',
        SHUTDOWN_TIMEOUT_MS: '2000',
      },
      {
        listen: false,
        socketFactory: harness.factory,
        sessionStore: harness.store,
      },
    );

    await vi.waitFor(() => expect(harness.factory.create).toHaveBeenCalledTimes(1));
    const exit = vi.fn();
    const unsubscribe = registerSignalHandlers(running, exit);
    try {
      process.emit('SIGTERM');
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
      expect(harness.sockets[0]?.logout).not.toHaveBeenCalled();
      expect(harness.sockets[0]?.end).toHaveBeenCalled();
      expect(harness.store.invalidate).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});

function required<T>(value: T | undefined): T {
  if (!value) {
    throw new Error('Expected a value');
  }
  return value;
}
