const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export interface SendSlot {
  pace(): Promise<void>;
  markAttempted(): void;
  holdUntilSettled(pending: Promise<unknown>): void;
}

export type CoordinatorResult<T> =
  | { accepted: true; value: T }
  | { accepted: false; reason: 'rate_limited' | 'send_blocked' };

export interface SendCoordinatorOptions {
  delayMs: number;
  maxRequestsPerMinute: number;
  maxMessagesPerHour: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Serializes outbound sends for this process and applies the shared delay and quotas.
 * There is no waiting queue beyond the single in-flight batch: a request either runs
 * when it reaches the lock or is rejected.
 */
export class SendCoordinator {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private tail: Promise<void> = Promise.resolve();
  private unresolved: Promise<unknown> | null = null;
  private requestTimes: number[] = [];
  private messageTimes: number[] = [];
  private lastSendAt = 0;

  constructor(private readonly options: SendCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  run<T>(recipientCount: number, task: (slot: SendSlot) => Promise<T>): Promise<CoordinatorResult<T>> {
    const run = this.tail.then(() => this.execute(recipientCount, task));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async execute<T>(
    recipientCount: number,
    task: (slot: SendSlot) => Promise<T>,
  ): Promise<CoordinatorResult<T>> {
    if (this.unresolved) {
      return { accepted: false, reason: 'send_blocked' };
    }

    const now = this.now();
    this.requestTimes = this.requestTimes.filter((timestamp) => now - timestamp < MINUTE_MS);
    this.messageTimes = this.messageTimes.filter((timestamp) => now - timestamp < HOUR_MS);
    if (this.requestTimes.length >= this.options.maxRequestsPerMinute) {
      return { accepted: false, reason: 'rate_limited' };
    }
    if (this.messageTimes.length + recipientCount > this.options.maxMessagesPerHour) {
      return { accepted: false, reason: 'rate_limited' };
    }
    this.requestTimes.push(now);

    const slot: SendSlot = {
      pace: async () => {
        if (this.lastSendAt === 0) {
          return;
        }
        const wait = this.options.delayMs - (this.now() - this.lastSendAt);
        if (wait > 0) {
          await this.sleep(wait);
        }
      },
      markAttempted: () => {
        const attemptedAt = this.now();
        this.messageTimes.push(attemptedAt);
        this.lastSendAt = attemptedAt;
      },
      holdUntilSettled: (pending) => {
        const tracked = Promise.resolve(pending).then(
          () => undefined,
          () => undefined,
        );
        this.unresolved = tracked;
        void tracked.finally(() => {
          if (this.unresolved === tracked) {
            this.unresolved = null;
          }
        });
      },
    };

    const value = await task(slot);
    return { accepted: true, value };
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
