import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSessionStore } from '../../src/core/whatsapp/session-store.js';
import type { AuthStateFactory } from '../../src/core/whatsapp/session-store.js';
import { createMemoryLogger } from '../helpers/memory-logger.js';

const directories: string[] = [];

describe('session store', () => {
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('creates the auth directory and does not call the provider for corrupt files (TC-010)', async () => {
    const directory = await makeTempDir();
    const nested = path.join(directory, 'nested', 'auth');
    const factory = vi.fn<AuthStateFactory>(async () => {
      throw new Error('factory should not run');
    });
    const logger = createMemoryLogger();
    const store = new FileSessionStore(nested, logger, factory);

    await expect(store.load()).rejects.toThrow(/could not be loaded|factory should not run/);
    await writeFile(path.join(nested, 'creds.json'), '{', 'utf8');
    await expect(store.load()).rejects.toThrow(/corrupted/);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(logger.text()).not.toContain('noiseKey');
  });

  it('reports an unreadable auth file without deleting it', async () => {
    const directory = await makeTempDir();
    await writeFile(path.join(directory, 'creds.json'), '{"registered":false}', 'utf8');
    const unreadable = path.join(directory, 'session-abc.json');
    await writeFile(unreadable, '{}', 'utf8');
    const store = new FileSessionStore(directory, createMemoryLogger(), async () => {
      throw new Error('should not load a partially unreadable store in this test');
    });

    await rm(unreadable);
    await writeFile(path.join(directory, 'pre-key-1.json'), '{', 'utf8');
    await expect(store.load()).rejects.toThrow(/corrupted/);
  });

  it('persists credentials and signal keys (TC-016)', async () => {
    const directory = await makeTempDir();
    const logger = createMemoryLogger();
    const store = new FileSessionStore(directory, logger);
    const first = await store.load();
    expect(first.registered).toBe(false);

    const creds = first.state.creds;
    if (!creds) {
      throw new Error('Expected credentials to be initialized');
    }
    creds.registered = true;
    creds.me = { id: '919876543210:1@s.whatsapp.net', name: 'My WhatsApp' };
    await first.saveCreds();
    await first.state.keys.set({
      'sender-key-memory': {
        'chat-1': { '919876543210@s.whatsapp.net': true },
      },
    });

    const credsOnDisk = await readFile(path.join(directory, 'creds.json'), 'utf8');
    expect(credsOnDisk.length).toBeGreaterThan(10);

    const second = await store.load();
    expect(second.registered).toBe(true);
    expect(second.state.creds?.me?.id).toContain('919876543210');
    const keys = await second.state.keys.get('sender-key-memory', ['chat-1']);
    expect(keys['chat-1']).toEqual({ '919876543210@s.whatsapp.net': true });
    expect(logger.text()).not.toContain('signedIdentityKey');
    expect(logger.text()).not.toContain('919876543210');
  });

  it('invalidates every file in the auth directory', async () => {
    const directory = await makeTempDir();
    await writeFile(path.join(directory, 'creds.json'), '{"registered":true}', 'utf8');
    await writeFile(path.join(directory, 'pre-key-1.json'), '{}', 'utf8');
    const store = new FileSessionStore(directory, createMemoryLogger(), async () => ({
      state: { creds: { registered: false }, keys: { get: async () => ({}), set: async () => undefined } },
      saveCreds: async () => undefined,
    }));

    await store.invalidate();
    expect(await readdir(directory)).toEqual([]);
  });

  it('keeps authentication paths out of git', async () => {
    const gitignore = await readFile(path.resolve('.gitignore'), 'utf8');
    expect(gitignore).toMatch(/^data\/$/m);
    expect(gitignore).toMatch(/^\.env$/m);
  });
});

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'wa-auth-'));
  directories.push(directory);
  return directory;
}
