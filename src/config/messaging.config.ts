import { IDEMPOTENCY_TTL_MS } from '../core/messaging/messaging.types.js';
import type { MessagingConfig } from '../core/messaging/messaging.types.js';
import { normalizeRecipient } from '../core/messaging/recipient-validator.js';

export function parseMessagingConfig(env: NodeJS.ProcessEnv, errors: string[]): MessagingConfig | undefined {
  const maxRecipientsPerRequest = readBoundedInteger(
    env.MAX_RECIPIENTS_PER_REQUEST,
    10,
    'MAX_RECIPIENTS_PER_REQUEST',
    errors,
    1,
    10,
  );
  const maxMessageLength = readBoundedInteger(
    env.MAX_MESSAGE_LENGTH,
    4000,
    'MAX_MESSAGE_LENGTH',
    errors,
    1,
    4000,
  );
  const sendDelayMs = readBoundedInteger(env.SEND_DELAY_MS, 1500, 'SEND_DELAY_MS', errors, 0, 60_000);
  const maxSendRequestsPerMinute = readBoundedInteger(
    env.MAX_SEND_REQUESTS_PER_MINUTE,
    10,
    'MAX_SEND_REQUESTS_PER_MINUTE',
    errors,
    1,
    1000,
  );
  const maxOutboundMessagesPerHour = readBoundedInteger(
    env.MAX_OUTBOUND_MESSAGES_PER_HOUR,
    30,
    'MAX_OUTBOUND_MESSAGES_PER_HOUR',
    errors,
    1,
    10_000,
  );
  const sendTimeoutMs = readBoundedInteger(env.SEND_TIMEOUT_MS, 30_000, 'SEND_TIMEOUT_MS', errors, 1000, 120_000);
  const allowAllRecipients = readBoolean(env.ALLOW_ALL_RECIPIENTS, false, 'ALLOW_ALL_RECIPIENTS', errors);
  const allowedRecipients = readAllowlist(env.ALLOWED_RECIPIENTS, errors);

  if (
    maxRecipientsPerRequest === undefined ||
    maxMessageLength === undefined ||
    sendDelayMs === undefined ||
    maxSendRequestsPerMinute === undefined ||
    maxOutboundMessagesPerHour === undefined ||
    sendTimeoutMs === undefined ||
    allowAllRecipients === undefined ||
    allowedRecipients === undefined
  ) {
    return undefined;
  }

  return {
    maxRecipientsPerRequest,
    maxMessageLength,
    sendDelayMs,
    maxSendRequestsPerMinute,
    maxOutboundMessagesPerHour,
    sendTimeoutMs,
    allowAllRecipients,
    allowedRecipients,
    idempotencyTtlMs: IDEMPOTENCY_TTL_MS,
  };
}

function readAllowlist(value: string | undefined, errors: string[]): string[] | undefined {
  if (value === undefined || value.trim() === '') {
    return [];
  }
  const parts = value.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const [index, part] of parts.entries()) {
    const phone = normalizeRecipient(part);
    if (!phone) {
      errors.push(`ALLOWED_RECIPIENTS entry ${index + 1} is not a valid international phone number.`);
      return undefined;
    }
    if (!seen.has(phone)) {
      seen.add(phone);
      normalized.push(phone);
    }
  }
  return normalized;
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

function readBoundedInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  errors: string[],
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  if (!/^\d+$/.test(value.trim())) {
    errors.push(`${name} must be an integer between ${min} and ${max}.`);
    return undefined;
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    errors.push(`${name} must be an integer between ${min} and ${max}.`);
    return undefined;
  }
  return parsed;
}
