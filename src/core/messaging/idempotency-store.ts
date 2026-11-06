import type { SendCompletedBody } from './messaging.types.js';

interface IdempotencyRecord {
  fingerprint: string;
  expiresAt: number;
  state: 'running' | 'completed';
  response?: SendCompletedBody;
}

export type IdempotencyBegin =
  | { action: 'start' }
  | { action: 'replay'; response: SendCompletedBody }
  | { action: 'in_progress' }
  | { action: 'conflict' };

export class IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxRecords = 200,
    private readonly now: () => number = Date.now,
  ) {}

  begin(key: string, fingerprint: string): IdempotencyBegin {
    this.evict();
    const existing = this.records.get(key);
    if (!existing) {
      this.records.set(key, {
        fingerprint,
        expiresAt: this.now() + this.ttlMs,
        state: 'running',
      });
      this.trim();
      return { action: 'start' };
    }
    if (existing.fingerprint !== fingerprint) {
      return { action: 'conflict' };
    }
    if (existing.state === 'running' || !existing.response) {
      return { action: 'in_progress' };
    }
    return { action: 'replay', response: existing.response };
  }

  complete(key: string, response: SendCompletedBody): void {
    const existing = this.records.get(key);
    if (!existing || existing.state !== 'running') {
      return;
    }
    existing.state = 'completed';
    existing.response = response;
    existing.expiresAt = this.now() + this.ttlMs;
  }

  abandon(key: string): void {
    const existing = this.records.get(key);
    if (existing?.state === 'running') {
      this.records.delete(key);
    }
  }

  size(): number {
    this.evict();
    return this.records.size;
  }

  private evict(): void {
    const now = this.now();
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(key);
      }
    }
  }

  private trim(): void {
    while (this.records.size > this.maxRecords) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.records.delete(oldest);
    }
  }
}
