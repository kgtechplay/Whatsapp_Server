import pino from 'pino';
import type { LogLevel } from './env.js';
import { redactString, sanitizeForLog } from '../shared/utils/redact.js';

export type LogFields = Record<string, unknown>;

export interface AppLogger {
  debug(fields: LogFields, message?: string): void;
  info(fields: LogFields, message?: string): void;
  warn(fields: LogFields, message?: string): void;
  error(fields: LogFields, message?: string): void;
  fatal(fields: LogFields, message?: string): void;
}

export interface LoggerOptions {
  level: LogLevel;
  secrets: readonly string[];
  destination?: pino.DestinationStream;
}

const REDACT_PATHS = [
  'qr',
  '*.qr',
  'err.qr',
  'apiKey',
  '*.apiKey',
  'err.apiKey',
  'API_KEY',
  'authorization',
  'req.headers.authorization',
  'creds',
  'creds.*',
  'err.creds',
  'noiseKey',
  'signedIdentityKey',
  'signedPreKey',
  'advSecretKey',
  'keys',
  'err.keys',
  'node',
  'msg.message',
  'message.message',
];

export class PinoAppLogger implements AppLogger {
  constructor(
    private readonly raw: pino.Logger,
    private readonly secrets: readonly string[],
  ) {}

  debug(fields: LogFields, message?: string): void {
    this.write('debug', fields, message);
  }

  info(fields: LogFields, message?: string): void {
    this.write('info', fields, message);
  }

  warn(fields: LogFields, message?: string): void {
    this.write('warn', fields, message);
  }

  error(fields: LogFields, message?: string): void {
    this.write('error', fields, message);
  }

  fatal(fields: LogFields, message?: string): void {
    this.write('fatal', fields, message);
  }

  /**
   * Baileys writes its own diagnostic logs. Keep that logger at warn or quieter
   * so connection-update payloads, including QR strings, are not emitted when
   * the application log level is debug or trace.
   */
  baileys(): pino.Logger {
    return this.raw.child({ component: 'baileys' }, { level: 'warn' });
  }

  private write(level: pino.Level, fields: LogFields, message?: string): void {
    const safeFields = sanitizeForLog(fields, this.secrets);
    const payload = safeFields && typeof safeFields === 'object' && !Array.isArray(safeFields) ? safeFields : {};
    const safeMessage = message === undefined ? undefined : redactString(message, this.secrets);
    if (safeMessage === undefined) {
      this.raw[level](payload);
      return;
    }
    this.raw[level](payload, safeMessage);
  }
}

export function createLogger(options: LoggerOptions): PinoAppLogger {
  const destination = options.destination ?? createDefaultDestination();
  const raw = pino(
    {
      level: options.level,
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
      formatters: {
        level(label) {
          return { level: label };
        },
      },
      redact: {
        paths: REDACT_PATHS,
        censor: '[redacted]',
      },
      base: {
        service: 'whatsapp-gateway',
      },
    },
    destination,
  );

  return new PinoAppLogger(raw, options.secrets);
}

function createDefaultDestination(): pino.DestinationStream {
  const destination = pino.destination({ dest: 1, sync: true, minLength: 0 });
  (destination as { unref?: () => void }).unref?.();
  return destination;
}
