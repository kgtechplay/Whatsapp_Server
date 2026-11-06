import { describe, expect, it } from 'vitest';
import { maskPhoneNumber, normalizeRecipient, toWhatsAppJid } from '../../src/core/messaging/recipient-validator.js';
import { parseSendRequest } from '../../src/api/validators/send-message.schema.js';
import type { MessagingConfig } from '../../src/core/messaging/messaging.types.js';
import { IDEMPOTENCY_TTL_MS } from '../../src/core/messaging/messaging.types.js';

const config: MessagingConfig = {
  maxRecipientsPerRequest: 10,
  maxMessageLength: 4000,
  sendDelayMs: 0,
  maxSendRequestsPerMinute: 10,
  maxOutboundMessagesPerHour: 30,
  sendTimeoutMs: 30_000,
  allowAllRecipients: true,
  allowedRecipients: [],
  idempotencyTtlMs: IDEMPOTENCY_TTL_MS,
};

describe('recipient validation', () => {
  it('normalizes numbers with and without a leading plus', () => {
    expect(normalizeRecipient('+919876543210')).toBe('919876543210');
    expect(normalizeRecipient('919876543210')).toBe('919876543210');
    expect(normalizeRecipient('+1 415-555-2671')).toBe('14155552671');
    expect(toWhatsAppJid('919876543210')).toBe('919876543210@s.whatsapp.net');
  });

  it('rejects numbers that omit the country code or are malformed', () => {
    expect(normalizeRecipient('9876543210')).toBeNull();
    expect(normalizeRecipient('919876543210 x12')).toBeNull();
    expect(normalizeRecipient('not-a-phone')).toBeNull();
    expect(normalizeRecipient('+000')).toBeNull();
  });

  it('masks all but the last four digits', () => {
    expect(maskPhoneNumber('919876543210')).toBe('***3210');
    expect(maskPhoneNumber('***3210')).not.toContain('919876543210');
  });

  it('rejects an empty message, duplicates, and too many recipients', () => {
    expect(parseSendRequest({ recipients: ['919876543210'], message: '   ' }, config).ok).toBe(false);
    const duplicates = parseSendRequest(
      { recipients: ['+919876543210', '919876543210'], message: 'Hello' },
      config,
    );
    expect(duplicates.ok).toBe(false);
    if (!duplicates.ok) {
      expect(duplicates.error.code).toBe('INVALID_RECIPIENT');
    }
    const tooMany = parseSendRequest(
      { recipients: Array.from({ length: 11 }, (_value, index) => `1415555${String(2671 + index).padStart(4, '0')}`), message: 'Hello' },
      { ...config, maxRecipientsPerRequest: 10 },
    );
    expect(tooMany.ok).toBe(false);
  });

  it('rejects recipients outside the allowlist and an empty allowlist', () => {
    const restricted = { ...config, allowAllRecipients: false, allowedRecipients: ['919876543210'] };
    const blocked = parseSendRequest({ recipients: ['14155552671'], message: 'Hello' }, restricted);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error.code).toBe('RECIPIENT_NOT_ALLOWED');
    }
    const empty = parseSendRequest(
      { recipients: ['919876543210'], message: 'Hello' },
      { ...config, allowAllRecipients: false, allowedRecipients: [] },
    );
    expect(empty.ok).toBe(false);
  });
});
