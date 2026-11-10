import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeDisconnect } from '../../src/core/whatsapp/baileys-socket.js';
import { classifyDisconnect, DisconnectCode } from '../../src/core/whatsapp/reconnect-policy.js';
import { BACKUP_DIRECTORY, describeAuthStorage, FileSessionStore, MAX_AUTH_BACKUPS } from '../../src/core/whatsapp/session-store.js';
import { createMemoryLogger } from '../helpers/memory-logger.js';
import { createHarness, emitClose, emitCloseWithError, emitOpen, streamError } from '../helpers/harness.js';

const directories: string[] = [];

describe('unexpected session loss', () => {
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('logs the raw status code and conflict type when WhatsApp removes the device', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ registered: true });
    await harness.manager.start();
    const socket = requiredSocket(harness.sockets[0]);
    emitOpen(socket);
    emitCloseWithError(
      socket,
      streamError('401', { tag: 'conflict', attrs: { type: 'device_removed' }, content: Buffer.from('binary-payload') }, 401),
    );

    const status = harness.manager.getStatus();
    expect(status).toMatchObject({
      status: 'LOGGED_OUT',
      lastError: { category: 'logged_out', statusCode: 401, reason: 'device_removed' },
    });
    const entry = harness.logger.entries.find((item) => item.fields.event === 'whatsapp.disconnected');
    expect(entry?.fields.disconnect).toMatchObject({
      statusCode: 401,
      reasonName: 'loggedOut',
      streamErrorCode: '401',
      streamErrorTag: 'conflict',
      conflictType: 'device_removed',
    });
    expect(harness.logger.text()).not.toContain('binary-payload');

    expect(socket.logout).not.toHaveBeenCalled();
    expect(harness.store.invalidate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.factory.create).toHaveBeenCalledTimes(1);
  });

  it('stops reconnecting when another client replaces the session, and keeps credentials', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ registered: true });
    await harness.manager.start();
    const socket = requiredSocket(harness.sockets[0]);
    emitOpen(socket);
    emitCloseWithError(socket, streamError(undefined, { tag: 'conflict', attrs: { type: 'replaced' } }, 440));

    expect(harness.manager.getStatus()).toMatchObject({
      status: 'DISCONNECTED',
      lastError: { category: 'connection_replaced', statusCode: 440, reason: 'replaced' },
    });
    expect(harness.manager.hasPendingRetry()).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.factory.create).toHaveBeenCalledTimes(1);

    const result = await harness.manager.requestConnect();
    expect(result.initiated).toBe(true);
    expect(harness.store.invalidate).not.toHaveBeenCalled();
    expect(harness.factory.create).toHaveBeenCalledTimes(2);
    expect(socket.logout).not.toHaveBeenCalled();
  });

  it('never calls WhatsApp logout or deletes auth for any automatic disconnect', async () => {
    vi.useFakeTimers();
    const codes = Object.values(DisconnectCode);
    for (const code of codes) {
      const harness = createHarness({ registered: true });
      await harness.manager.start();
      const socket = requiredSocket(harness.sockets[0]);
      emitOpen(socket);
      emitClose(socket, code);
      await vi.advanceTimersByTimeAsync(120_000);
      for (const later of harness.sockets) {
        expect(later.logout).not.toHaveBeenCalled();
      }
      expect(harness.store.invalidate).not.toHaveBeenCalled();
      await harness.manager.shutdown();
    }
  });

  it('keeps reconnecting for restart, closed, and lost connections', () => {
    for (const code of [DisconnectCode.restartRequired, DisconnectCode.connectionClosed, DisconnectCode.connectionLost]) {
      expect(classifyDisconnect(code)).toMatchObject({ recoverable: true, resetCredentials: false });
    }
    expect(classifyDisconnect(DisconnectCode.connectionReplaced)).toMatchObject({
      recoverable: false,
      resetCredentials: false,
      state: 'DISCONNECTED',
    });
  });

  it('waits for in-flight Signal key writes before shutdown finishes', async () => {
    const harness = createHarness({ registered: true });
    let finishWrite: () => void = () => undefined;
    harness.state.keys.set.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          finishWrite = () => resolve(undefined);
        }),
    );
    await harness.manager.start();
    const call = harness.factory.create.mock.calls[0] as unknown[] | undefined;
    const passed = call?.[0] as { keys: { set: (data: unknown) => Promise<void> } };
    const write = passed.keys.set({ 'pre-key': { '1': { public: 'x' } } });

    let shutdownDone = false;
    const shutdown = harness.manager.shutdown().then(() => {
      shutdownDone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(shutdownDone).toBe(false);

    finishWrite();
    await write;
    await shutdown;
    expect(shutdownDone).toBe(true);
    expect(harness.state.keys.set).toHaveBeenCalledTimes(1);
  });

  it('moves auth files to a backup instead of deleting them', async () => {
    const directory = await makeTempDir();
    await writeFile(path.join(directory, 'creds.json'), '{"registered":true}', 'utf8');
    await writeFile(path.join(directory, 'pre-key-1.json'), '{}', 'utf8');
    const logger = createMemoryLogger();
    const store = new FileSessionStore(directory, logger);

    await store.invalidate();
    expect(await readdir(directory)).toEqual([BACKUP_DIRECTORY]);
    const [backup] = await readdir(path.join(directory, BACKUP_DIRECTORY));
    if (!backup) {
      throw new Error('Expected a backup');
    }
    const saved = path.join(directory, BACKUP_DIRECTORY, backup);
    expect((await readdir(saved)).sort()).toEqual(['creds.json', 'pre-key-1.json']);
    expect(await readFile(path.join(saved, 'creds.json'), 'utf8')).toBe('{"registered":true}');

    const reloaded = await store.load();
    expect(reloaded.registered).toBe(false);
  });

  it('keeps only the newest backups', async () => {
    const directory = await makeTempDir();
    const store = new FileSessionStore(directory, createMemoryLogger());
    for (let index = 0; index < MAX_AUTH_BACKUPS + 2; index += 1) {
      await writeFile(path.join(directory, 'creds.json'), `{"n":${index}}`, 'utf8');
      await store.invalidate();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const backups = (await readdir(path.join(directory, BACKUP_DIRECTORY))).sort();
    expect(backups).toHaveLength(MAX_AUTH_BACKUPS);
    const newest = backups[backups.length - 1];
    if (!newest) {
      throw new Error('Expected a backup');
    }
    const content = await readFile(path.join(directory, BACKUP_DIRECTORY, newest, 'creds.json'), 'utf8');
    expect(content).toBe(`{"n":${MAX_AUTH_BACKUPS + 1}}`);
  });

  it('reports whether the auth path is on the Railway volume', () => {
    const host = { hostname: 'container-a', pid: 1 };
    const railway = { RAILWAY_ENVIRONMENT_NAME: 'production', RAILWAY_DEPLOYMENT_ID: 'dep-1', RAILWAY_REPLICA_ID: 'rep-1' };

    expect(
      describeAuthStorage({ ...railway, RAILWAY_VOLUME_MOUNT_PATH: '/data' }, '/data/baileys-auth', host),
    ).toMatchObject({ onRailway: true, onVolume: true, instance: { deploymentId: 'dep-1', replicaId: 'rep-1' } });
    expect(describeAuthStorage({ ...railway, RAILWAY_VOLUME_MOUNT_PATH: '/data' }, '/app/data/baileys-auth', host)).toMatchObject({
      onVolume: false,
    });
    expect(describeAuthStorage(railway, '/data/baileys-auth', host)).toMatchObject({ onVolume: false, volumeMountPath: null });
    expect(describeAuthStorage({}, './data/baileys-auth', host)).toMatchObject({ onRailway: false, onVolume: null });
  });

  it('reads the Baileys 7 stream error shape, where data is the reason node', async () => {
    vi.useFakeTimers();
    const v7Error = Object.assign(new Error('Stream Errored (conflict)'), {
      output: { statusCode: 401 },
      data: { tag: 'conflict', attrs: { type: 'device_removed' } },
    });
    expect(describeDisconnect(v7Error)).toMatchObject({
      statusCode: 401,
      streamErrorTag: 'conflict',
      conflictType: 'device_removed',
      failureReason: null,
    });

    const harness = createHarness({ registered: true });
    await harness.manager.start();
    const socket = requiredSocket(harness.sockets[0]);
    emitOpen(socket);
    emitCloseWithError(socket, v7Error);
    expect(harness.manager.getStatus().lastError).toMatchObject({ statusCode: 401, reason: 'device_removed' });
  });

  it('handles the async socket end used by Baileys 7 without an unhandled rejection', async () => {
    const harness = createHarness({ registered: true });
    await harness.manager.start();
    const socket = requiredSocket(harness.sockets[0]);
    socket.end.mockImplementation(() => Promise.reject(new Error('close failed')));
    emitOpen(socket);

    await harness.manager.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket.end).toHaveBeenCalledTimes(1);
    expect(socket.logout).not.toHaveBeenCalled();
    expect(harness.logger.entries.some((entry) => entry.message === 'Socket close failed')).toBe(true);
  });

  it('treats a QR-linked session as saved even though Baileys leaves registered false', async () => {
    const directory = await makeTempDir();
    const store = new FileSessionStore(directory, createMemoryLogger());
    const first = await store.load();
    if (!first.state.creds) {
      throw new Error('Expected credentials');
    }
    expect(first.registered).toBe(false);
    first.state.creds.registered = false;
    first.state.creds.me = { id: '919876543210:7@s.whatsapp.net', name: 'My WhatsApp' };
    await first.saveCreds();

    const second = await store.load();
    expect(second.registered).toBe(true);
  });

  it('keeps a QR-linked session when logout is requested while disconnected', async () => {
    const offline = createHarness();
    await offline.manager.start();
    const socket = requiredSocket(offline.sockets[0]);
    offline.state.creds.registered = false;
    offline.state.creds.me = { id: '919876543210:7@s.whatsapp.net' };
    socket.emit('creds.update');
    emitCloseWithError(socket, Object.assign(new Error('closed'), { output: { statusCode: 500 } }));

    const result = await offline.manager.requestLogout();
    expect(result).toMatchObject({ success: false, remoteConfirmed: false });
    expect(offline.store.invalidate).not.toHaveBeenCalled();
  });

  it('extracts failure reasons and ignores unsafe values', () => {
    const failure = Object.assign(new Error('Connection Failure'), {
      output: { statusCode: 401 },
      data: { reason: '401', location: 'frc' },
    });
    expect(describeDisconnect(failure)).toMatchObject({ statusCode: 401, failureReason: '401', failureLocation: 'frc' });

    const unsafe = streamError('401', { tag: 'conflict', attrs: { type: 'x'.repeat(500) } }, 401);
    expect(describeDisconnect(unsafe).conflictType).toBeNull();
    expect(describeDisconnect(undefined)).toMatchObject({ statusCode: null, reasonName: null });
  });
});

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'wa-loss-'));
  directories.push(directory);
  return directory;
}

function requiredSocket<T>(socket: T | undefined): T {
  if (!socket) {
    throw new Error('Expected a socket');
  }
  return socket;
}
