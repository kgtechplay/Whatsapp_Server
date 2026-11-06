import { describe, expect, it } from 'vitest';
import { IdempotencyStore } from '../../src/core/messaging/idempotency-store.js';
import type { SendCompletedBody } from '../../src/core/messaging/messaging.types.js';

const stored: SendCompletedBody = {
  requestId: 'req_stored',
  status: 'completed',
  summary: { total: 1, sent: 1, failed: 0, notSent: 0, unknown: 0 },
  results: [{ number: '919876543210', status: 'sent', messageId: 'mid-1' }],
};

describe('idempotency store', () => {
  it('replays a completed request and does not treat it as a new send', () => {
    const store = new IdempotencyStore(10 * 60 * 1000, 200, () => 1_000);
    expect(store.begin('key-1', 'payload-a')).toEqual({ action: 'start' });
    store.complete('key-1', stored);
    expect(store.begin('key-1', 'payload-a')).toEqual({ action: 'replay', response: stored });
  });

  it('reports a key that is still running', () => {
    const store = new IdempotencyStore(10 * 60 * 1000, 200, () => 1_000);
    store.begin('key-1', 'payload-a');
    expect(store.begin('key-1', 'payload-a')).toEqual({ action: 'in_progress' });
  });

  it('conflicts when the same key is reused for a different payload', () => {
    const store = new IdempotencyStore(10 * 60 * 1000, 200, () => 1_000);
    store.begin('key-1', 'payload-a');
    expect(store.begin('key-1', 'payload-b')).toEqual({ action: 'conflict' });
  });

  it('expires records and stays within its memory bound', () => {
    let now = 1_000;
    const store = new IdempotencyStore(500, 2, () => now);
    store.begin('key-1', 'a');
    store.complete('key-1', stored);
    now = 1_600;
    expect(store.begin('key-1', 'a')).toEqual({ action: 'start' });

    store.begin('key-2', 'b');
    store.begin('key-3', 'c');
    store.begin('key-4', 'd');
    expect(store.size()).toBeLessThanOrEqual(2);
  });
});
