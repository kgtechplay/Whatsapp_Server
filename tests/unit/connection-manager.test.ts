import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthStoreError, OperationConflictError } from '../../src/shared/errors/app-error.js';
import { DisconnectCode } from '../../src/core/whatsapp/reconnect-policy.js';
import { FakeSocket, QR_PAYLOAD, createHarness, emitClose, emitOpen } from '../helpers/harness.js';

describe('connection manager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts without a saved session and exposes a pairing QR (TC-001)', async () => {
    const harness = createHarness();
    expect(harness.manager.getStatus().connected).toBe(false);

    await harness.manager.start();
    expect(harness.factory.create).toHaveBeenCalledTimes(1);
    expect(harness.manager.getStatus().status).toBe('CONNECTING');
    expect(harness.manager.getQr().kind).toBe('pending');

    harness.sockets[0]?.emit('connection.update', { qr: QR_PAYLOAD });

    const qr = harness.manager.getQr();
    expect(harness.manager.getStatus().status).toBe('QR_REQUIRED');
    expect(qr).toMatchObject({ kind: 'available', qr: QR_PAYLOAD, expiresAt: null });
    expect(harness.logger.text()).not.toContain(QR_PAYLOAD);
    expect(harness.logger.entries.some((entry) => entry.fields.event === 'whatsapp.qr.generated')).toBe(true);
  });

  it('reaches CONNECTED after the QR flow restarts and opens (TC-002)', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ random: () => 0.5 });
    await harness.manager.start();
    const first = requiredSocket(harness.sockets[0]);
    first.emit('connection.update', { qr: QR_PAYLOAD });
    harness.state.creds.registered = true;
    first.emit('creds.update');
    emitClose(first, DisconnectCode.restartRequired);

    expect(harness.manager.getStatus().status).toBe('RECONNECTING');
    await vi.advanceTimersByTimeAsync(2000);

    expect(harness.sockets).toHaveLength(2);
    emitOpen(requiredSocket(harness.sockets[1]));
    expect(harness.manager.getStatus()).toMatchObject({
      status: 'CONNECTED',
      connected: true,
      account: { id: '919876543210', name: 'My WhatsApp' },
      reconnectAttempts: 0,
      lastError: null,
    });
    expect(harness.manager.getQr().kind).toBe('not-applicable');
    expect(harness.manager.isConnected()).toBe(true);
    expect(harness.logger.text()).not.toContain(QR_PAYLOAD);
  });

  it('reconnects saved credentials without exposing a QR (TC-003)', async () => {
    const harness = createHarness({ registered: true });
    expect(harness.manager.getStatus().connected).toBe(false);

    await harness.manager.start();
    expect(harness.manager.getStatus().status).not.toBe('QR_REQUIRED');
    expect(harness.manager.getQr().kind).toBe('not-applicable');

    emitOpen(requiredSocket(harness.sockets[0]));
    expect(harness.manager.getStatus()).toMatchObject({
      status: 'CONNECTED',
      connected: true,
      account: { id: '919876543210', name: 'My WhatsApp' },
    });
    expect(harness.logger.entries.some((entry) => entry.fields.event === 'whatsapp.qr.generated')).toBe(false);
  });

  it('schedules a retry after a temporary network failure and recovers (TC-004, TC-005, TC-013)', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ registered: true, random: () => 0.5 });
    await harness.manager.start();
    emitOpen(requiredSocket(harness.sockets[0]));
    emitClose(requiredSocket(harness.sockets[0]), DisconnectCode.connectionClosed);

    expect(harness.manager.getStatus()).toMatchObject({
      status: 'RECONNECTING',
      connected: false,
      reconnectAttempts: 1,
      lastError: { category: 'network' },
    });
    expect(harness.manager.getStatus().lastDisconnectedAt).toEqual(expect.any(String));
    expect(harness.manager.hasPendingRetry()).toBe(true);

    await vi.advanceTimersByTimeAsync(1999);
    expect(harness.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.sockets).toHaveLength(2);

    emitOpen(requiredSocket(harness.sockets[1]));
    expect(harness.manager.getStatus()).toMatchObject({
      status: 'CONNECTED',
      connected: true,
      reconnectAttempts: 0,
      lastError: null,
    });
    expect(harness.manager.getStatus().lastConnectedAt).toEqual(expect.any(String));
    expect(harness.manager.getStatus().lastDisconnectedAt).toEqual(expect.any(String));
    expect(harness.logger.entries.some((entry) => entry.fields.event === 'whatsapp.reconnect.succeeded')).toBe(true);
  });

  it('stops retries after an explicit logout (TC-006)', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ registered: true, random: () => 0.5 });
    await harness.manager.start();
    const socket = requiredSocket(harness.sockets[0]);
    emitOpen(socket);

    const result = await harness.manager.requestLogout();
    expect(result).toMatchObject({ success: true, status: 'LOGGED_OUT', remoteConfirmed: true });
    expect(socket.logout).toHaveBeenCalledTimes(1);
    expect(harness.store.invalidate).toHaveBeenCalledTimes(1);
    expect(harness.manager.hasPendingRetry()).toBe(false);
    expect(harness.manager.getStatus().status).toBe('LOGGED_OUT');
    expect(harness.manager.getStatus().account).toBeNull();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.factory.create).toHaveBeenCalledTimes(1);
  });

  it('does not claim logout success when the remote logout fails', async () => {
    const harness = createHarness({ registered: true });
    await harness.manager.start();
    const socket = requiredSocket(harness.sockets[0]);
    emitOpen(socket);
    socket.logout.mockRejectedValue(new Error('logout failed'));

    const result = await harness.manager.requestLogout();
    expect(result.success).toBe(false);
    expect(result.remoteConfirmed).toBe(false);
    expect(harness.store.invalidate).not.toHaveBeenCalled();
    expect(harness.manager.getStatus().status).not.toBe('LOGGED_OUT');
    expect(harness.manager.hasPendingRetry()).toBe(false);
  });

  it('does not create duplicate sockets for repeated connect calls (TC-007, TC-015)', async () => {
    const harness = createHarness();
    let release: (socket: FakeSocket) => void = () => undefined;
    const gate = new Promise<FakeSocket>((resolve) => {
      release = resolve;
    });
    harness.factory.create.mockImplementation(async () => gate);

    const first = harness.manager.requestConnect();
    const second = harness.manager.requestConnect();
    const third = harness.manager.requestConnect();
    const socket = new FakeSocket();
    release(socket);
    const results = await Promise.all([first, second, third]);

    expect(harness.factory.create).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result.initiated)).toHaveLength(1);
    expect(results.filter((result) => !result.initiated)).toHaveLength(2);

    emitOpen(socket);
    const again = await harness.manager.requestConnect();
    expect(again).toMatchObject({ initiated: false, status: 'CONNECTED' });
    expect(harness.factory.create).toHaveBeenCalledTimes(1);
  });

  it('rejects connect while logout is in progress', async () => {
    const harness = createHarness({ registered: true });
    await harness.manager.start();
    const socket = requiredSocket(harness.sockets[0]);
    emitOpen(socket);
    let release: () => void = () => undefined;
    socket.logout.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const logout = harness.manager.requestLogout();
    await expect(harness.manager.requestConnect()).rejects.toBeInstanceOf(OperationConflictError);
    release();
    await logout;
    expect(harness.manager.getStatus().status).toBe('LOGGED_OUT');
  });

  it('reports storage failures once and does not retry forever (TC-010)', async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      loadError: new AuthStoreError('Authentication file creds.json is unreadable.', 'unreadable'),
    });

    await harness.manager.start();
    expect(harness.manager.getStatus()).toMatchObject({
      status: 'ERROR',
      connected: false,
      lastError: { category: 'auth_store' },
    });
    expect(harness.factory.create).not.toHaveBeenCalled();
    expect(harness.manager.hasPendingRetry()).toBe(false);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.store.load).toHaveBeenCalledTimes(1);
    expect(harness.factory.create).not.toHaveBeenCalled();
    expect(harness.logger.text()).not.toContain('noiseKey');
  });

  it('shuts down without logging the WhatsApp account out (TC-011)', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ registered: true, random: () => 0.5 });
    await harness.manager.start();
    const socket = requiredSocket(harness.sockets[0]);
    emitOpen(socket);
    emitClose(socket, DisconnectCode.connectionLost);
    expect(harness.manager.hasPendingRetry()).toBe(true);

    await harness.manager.shutdown();
    expect(socket.logout).not.toHaveBeenCalled();
    expect(harness.store.invalidate).not.toHaveBeenCalled();
    expect(harness.manager.hasPendingRetry()).toBe(false);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.factory.create).toHaveBeenCalledTimes(1);
  });

  it('applies backoff across rapid failures and ignores a duplicate close (TC-014)', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ random: () => 0.5 });
    await harness.manager.start();
    const first = requiredSocket(harness.sockets[0]);
    emitClose(first, DisconnectCode.timedOut);
    emitClose(first, DisconnectCode.timedOut);

    expect(harness.manager.getStatus().reconnectAttempts).toBe(1);
    expect(harness.manager.hasPendingRetry()).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(harness.sockets).toHaveLength(2);

    emitClose(requiredSocket(harness.sockets[1]), DisconnectCode.connectionClosed);
    expect(harness.manager.getStatus().reconnectAttempts).toBe(2);
    await vi.advanceTimersByTimeAsync(3999);
    expect(harness.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.sockets).toHaveLength(3);
    expect(harness.logger.entries.filter((entry) => entry.fields.event === 'whatsapp.reconnect.scheduled')).toHaveLength(2);
  });

  it('saves credentials when Baileys emits creds.update (TC-016)', async () => {
    const harness = createHarness();
    await harness.manager.start();
    harness.state.creds.registered = true;
    requiredSocket(harness.sockets[0]).emit('creds.update');
    await vi.waitFor(() => expect(harness.saveCreds).toHaveBeenCalledTimes(1));
  });

  it('does not reconnect after the phone logs the session out', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ registered: true });
    await harness.manager.start();
    emitOpen(requiredSocket(harness.sockets[0]));
    emitClose(requiredSocket(harness.sockets[0]), DisconnectCode.loggedOut);

    expect(harness.manager.getStatus().status).toBe('LOGGED_OUT');
    expect(harness.manager.hasPendingRetry()).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.factory.create).toHaveBeenCalledTimes(1);
  });

  it('resets invalid credentials only when connect is requested again', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ registered: true });
    await harness.manager.start();
    emitClose(requiredSocket(harness.sockets[0]), DisconnectCode.badSession);
    expect(harness.manager.getStatus().status).toBe('ERROR');
    expect(harness.manager.hasPendingRetry()).toBe(false);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.factory.create).toHaveBeenCalledTimes(1);

    harness.store.load.mockResolvedValue({
      state: harness.state,
      saveCreds: harness.saveCreds,
      registered: false,
    });
    const result = await harness.manager.requestConnect();
    expect(harness.store.invalidate).toHaveBeenCalledTimes(1);
    expect(result.initiated).toBe(true);
    expect(harness.factory.create).toHaveBeenCalledTimes(2);
  });
});

function requiredSocket<T>(socket: T | undefined): T {
  if (!socket) {
    throw new Error('Expected a socket');
  }
  return socket;
}
