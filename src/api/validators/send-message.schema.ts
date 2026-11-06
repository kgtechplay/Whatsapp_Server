import type { MessagingConfig } from '../../core/messaging/messaging.types.js';
import { normalizeRecipient } from '../../core/messaging/recipient-validator.js';

export interface ParsedSendRequest {
  recipients: string[];
  message: string;
}

export interface RequestParseFailure {
  code: 'INVALID_REQUEST' | 'INVALID_RECIPIENT' | 'RECIPIENT_NOT_ALLOWED';
  message: string;
}

export function parseSendRequest(
  body: unknown,
  config: MessagingConfig,
): { ok: true; value: ParsedSendRequest } | { ok: false; error: RequestParseFailure } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return failure('INVALID_REQUEST', 'Request body must be a JSON object.');
  }
  const record = body as { recipients?: unknown; message?: unknown };
  if (!Array.isArray(record.recipients)) {
    return failure('INVALID_REQUEST', 'recipients must be an array of phone numbers.');
  }
  if (typeof record.message !== 'string') {
    return failure('INVALID_REQUEST', 'message must be a string.');
  }
  if (record.message.trim().length === 0) {
    return failure('INVALID_REQUEST', 'message must not be empty.');
  }
  if (characterLength(record.message) > config.maxMessageLength) {
    return failure('INVALID_REQUEST', `message must be at most ${config.maxMessageLength} characters.`);
  }
  if (record.recipients.length === 0) {
    return failure('INVALID_REQUEST', 'recipients must contain at least one phone number.');
  }
  if (record.recipients.length > config.maxRecipientsPerRequest) {
    return failure(
      'INVALID_REQUEST',
      `recipients must contain at most ${config.maxRecipientsPerRequest} phone numbers.`,
    );
  }

  const recipients: string[] = [];
  const seen = new Set<string>();
  for (const recipient of record.recipients) {
    if (typeof recipient !== 'string') {
      return failure('INVALID_RECIPIENT', 'Each recipient must be a string phone number.');
    }
    const normalized = normalizeRecipient(recipient);
    if (!normalized) {
      return failure(
        'INVALID_RECIPIENT',
        'Recipients must be valid international phone numbers, including the country code. A leading + is optional.',
      );
    }
    if (seen.has(normalized)) {
      return failure('INVALID_RECIPIENT', 'Duplicate recipient numbers are not allowed.');
    }
    seen.add(normalized);
    recipients.push(normalized);
  }

  if (!config.allowAllRecipients) {
    if (config.allowedRecipients.length === 0) {
      return failure(
        'RECIPIENT_NOT_ALLOWED',
        'Outbound messaging is disabled until ALLOWED_RECIPIENTS is set or ALLOW_ALL_RECIPIENTS is true.',
      );
    }
    const allowed = new Set(config.allowedRecipients);
    const blocked = recipients.filter((recipient) => !allowed.has(recipient));
    if (blocked.length > 0) {
      return failure('RECIPIENT_NOT_ALLOWED', 'One or more recipients are not in ALLOWED_RECIPIENTS.');
    }
  }

  return { ok: true, value: { recipients, message: record.message } };
}

function failure(code: RequestParseFailure['code'], message: string): { ok: false; error: RequestParseFailure } {
  return { ok: false, error: { code, message } };
}

function characterLength(value: string): number {
  return Array.from(value).length;
}
