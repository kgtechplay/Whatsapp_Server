import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { createLogger } from '../../src/config/logger.js';
import { ConfigError } from '../../src/shared/errors/app-error.js';
import { startApplication } from '../../src/server.js';

const validEnv = {
  NODE_ENV: 'test',
  PORT: '3000',
  WHATSAPP_AUTH_PATH: './data/baileys-auth',
  AUTO_RECONNECT: 'true',
  RECONNECT_INITIAL_DELAY_MS: '2000',
  RECONNECT_MAX_DELAY_MS: '60000',
  API_KEY: 'replace_with_a_strong_random_secret',
  LOG_LEVEL: 'info',
  SHUTDOWN_TIMEOUT_MS: '10000',
};

describe('configuration and log redaction', () => {
  it('rejects invalid environment configuration before startup (TC-012)', async () => {
    expect(() => loadConfig({ ...validEnv, PORT: 'nope' })).toThrow(/PORT must be an integer/);
    expect(() => loadConfig({ ...validEnv, API_KEY: 'short-secret' })).toThrow(/API_KEY must be at least 16 characters/);
    expect(() => loadConfig({ ...validEnv, API_KEY: undefined })).toThrow(/API_KEY is required/);
    expect(() => loadConfig({ ...validEnv, WHATSAPP_AUTH_PATH: '  ' })).toThrow(/WHATSAPP_AUTH_PATH is required/);
    expect(() => loadConfig({ ...validEnv, AUTO_RECONNECT: 'yes' })).toThrow(/AUTO_RECONNECT must be "true" or "false"/);
    expect(() => loadConfig({ ...validEnv, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL must be one of/);
    expect(() =>
      loadConfig({
        ...validEnv,
        RECONNECT_INITIAL_DELAY_MS: '90000',
        RECONNECT_MAX_DELAY_MS: '1000',
      }),
    ).toThrow(/RECONNECT_INITIAL_DELAY_MS must be less than or equal/);

    const secret = 'short-secret';
    try {
      loadConfig({ ...validEnv, API_KEY: secret });
      throw new Error('expected invalid API_KEY to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain(secret);
    }

    await expect(
      startApplication({ ...validEnv, PORT: '-1', API_KEY: secret }, { listen: false }),
    ).rejects.toThrow(/Invalid configuration/);
  });

  it('accepts the example configuration', () => {
    const config = loadConfig(validEnv);
    expect(config).toMatchObject({
      nodeEnv: 'test',
      port: 3000,
      autoReconnect: true,
      reconnectInitialDelayMs: 2000,
      reconnectMaxDelayMs: 60_000,
      logLevel: 'info',
      shutdownTimeoutMs: 10_000,
    });
  });

  it('redacts QR payloads and API keys from logged error objects (TC-017)', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'wa-log-'));
    const file = path.join(directory, 'app.log');
    const destination = pino.destination({ dest: file, sync: true, mkdir: true });
    try {
      const apiKey = 'replace_with_a_strong_random_secret';
      const qr = '2@qr-payload-that-must-never-be-logged,abcdef';
      const logger = createLogger({ level: 'info', secrets: [apiKey], destination });
      logger.error(
        {
          event: 'app.unrecoverable',
          connectionState: 'ERROR',
          errorCategory: 'test',
          err: {
            message: `failed while using ${apiKey}`,
            qr,
            apiKey,
            creds: { noiseKey: 'super-secret-noise' },
          },
        },
        `boom ${apiKey}`,
      );
      destination.flushSync();
      const text = readFileSync(file, 'utf8');
      expect(text).toContain('"event":"app.unrecoverable"');
      expect(text).toContain('"level":"error"');
      expect(text).toContain('"timestamp"');
      expect(text).toContain('[redacted]');
      expect(text).not.toContain(qr);
      expect(text).not.toContain(apiKey);
      expect(text).not.toContain('super-secret-noise');
    } finally {
      destination.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
