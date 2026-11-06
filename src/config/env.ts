import { parseMessagingConfig } from './messaging.config.js';
import type { MessagingConfig } from '../core/messaging/messaging.types.js';
import { ConfigError } from '../shared/errors/app-error.js';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export const NODE_ENVS = ['development', 'test', 'production'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type NodeEnv = (typeof NODE_ENVS)[number];

export interface AppConfig {
  nodeEnv: NodeEnv;
  port: number;
  whatsappAuthPath: string;
  autoReconnect: boolean;
  reconnectInitialDelayMs: number;
  reconnectMaxDelayMs: number;
  apiKey: string;
  logLevel: LogLevel;
  shutdownTimeoutMs: number;
  messaging: MessagingConfig;
}

const API_KEY_MIN_LENGTH = 16;
const MAX_TIMING_MS = 24 * 60 * 60 * 1000;

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const errors: string[] = [];

  const nodeEnv = readEnum(env.NODE_ENV, NODE_ENVS, 'development', 'NODE_ENV', errors);
  const port = readInteger(env.PORT, 3000, 'PORT', errors, { min: 1, max: 65_535 });
  const whatsappAuthPath = readRequiredString(env.WHATSAPP_AUTH_PATH, 'WHATSAPP_AUTH_PATH', errors);
  const autoReconnect = readBoolean(env.AUTO_RECONNECT, true, 'AUTO_RECONNECT', errors);
  const reconnectInitialDelayMs = readInteger(
    env.RECONNECT_INITIAL_DELAY_MS,
    2000,
    'RECONNECT_INITIAL_DELAY_MS',
    errors,
    { min: 1, max: MAX_TIMING_MS },
  );
  const reconnectMaxDelayMs = readInteger(
    env.RECONNECT_MAX_DELAY_MS,
    60_000,
    'RECONNECT_MAX_DELAY_MS',
    errors,
    { min: 1, max: MAX_TIMING_MS },
  );
  const apiKey = readApiKey(env.API_KEY, errors);
  const logLevel = readEnum(env.LOG_LEVEL, LOG_LEVELS, 'info', 'LOG_LEVEL', errors);
  const shutdownTimeoutMs = readInteger(
    env.SHUTDOWN_TIMEOUT_MS,
    10_000,
    'SHUTDOWN_TIMEOUT_MS',
    errors,
    { min: 1, max: MAX_TIMING_MS },
  );
  const messaging = parseMessagingConfig(env, errors);

  if (
    reconnectInitialDelayMs !== undefined &&
    reconnectMaxDelayMs !== undefined &&
    reconnectInitialDelayMs > reconnectMaxDelayMs
  ) {
    errors.push('RECONNECT_INITIAL_DELAY_MS must be less than or equal to RECONNECT_MAX_DELAY_MS.');
  }

  if (errors.length > 0 || apiKey === undefined || whatsappAuthPath === undefined || messaging === undefined) {
    throw new ConfigError(`Invalid configuration:\n- ${errors.join('\n- ')}`);
  }

  return {
    nodeEnv: nodeEnv ?? 'development',
    port: port ?? 3000,
    whatsappAuthPath,
    autoReconnect: autoReconnect ?? true,
    reconnectInitialDelayMs: reconnectInitialDelayMs ?? 2000,
    reconnectMaxDelayMs: reconnectMaxDelayMs ?? 60_000,
    apiKey,
    logLevel: logLevel ?? 'info',
    shutdownTimeoutMs: shutdownTimeoutMs ?? 10_000,
    messaging,
  };
}

function readRequiredString(
  value: string | undefined,
  name: string,
  errors: string[],
): string | undefined {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    errors.push(`${name} is required.`);
    return undefined;
  }
  return trimmed;
}

function readApiKey(value: string | undefined, errors: string[]): string | undefined {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    errors.push('API_KEY is required.');
    return undefined;
  }
  if (trimmed.length < API_KEY_MIN_LENGTH) {
    errors.push(`API_KEY must be at least ${API_KEY_MIN_LENGTH} characters.`);
    return undefined;
  }
  return trimmed;
}

function readBoolean(
  value: string | undefined,
  fallback: boolean,
  name: string,
  errors: string[],
): boolean | undefined {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  errors.push(`${name} must be "true" or "false".`);
  return undefined;
}

function readEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
  name: string,
  errors: string[],
): T | undefined {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const normalized = value.trim() as T;
  if (!allowed.includes(normalized)) {
    errors.push(`${name} must be one of: ${allowed.join(', ')}.`);
    return undefined;
  }
  return normalized;
}

function readInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  errors: string[],
  bounds: { min: number; max: number },
): number | undefined {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  if (!/^-?\d+$/.test(value.trim())) {
    errors.push(`${name} must be an integer between ${bounds.min} and ${bounds.max}.`);
    return undefined;
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < bounds.min || parsed > bounds.max) {
    errors.push(`${name} must be an integer between ${bounds.min} and ${bounds.max}.`);
    return undefined;
  }
  return parsed;
}
