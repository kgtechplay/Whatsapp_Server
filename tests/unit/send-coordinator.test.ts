import { describe, expect, it, vi } from 'vitest';
import { SendCoordinator } from '../../src/core/messaging/send-coordinator.js';

describe('send coordinator', () => {
  it('spaces sends by the configured delay across overlapping requests', async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new SendCoordinator({
        delayMs: 1000,
        maxRequestsPerMinute: 10,
        maxMessagesPerHour: 30,
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => {
          setTimeout(resolve, ms);
        }),
      });
      const order: string[] = [];
      const first = coordinator.run(1, async (slot) => {
        await slot.pace();
        slot.markAttempted();
        order.push('first');
        return 'first';
      });
      const second = coordinator.run(1, async (slot) => {
        await slot.pace();
        slot.markAttempted();
        order.push('second');
        return 'second';
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual(['first']);
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.all([first, second]);
      expect(order).toEqual(['first', 'second']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects requests that exceed the request or message quota', async () => {
    let now = 5_000;
    const coordinator = new SendCoordinator({
      delayMs: 0,
      maxRequestsPerMinute: 2,
      maxMessagesPerHour: 3,
      now: () => now,
      sleep: async () => undefined,
    });
    const send = async (): Promise<void> => {
      await coordinator.run(1, async (slot) => {
        await slot.pace();
        slot.markAttempted();
      });
    };
    await send();
    await send();
    const limited = await coordinator.run(1, async () => undefined);
    expect(limited).toEqual({ accepted: false, reason: 'rate_limited' });

    now = 120_000;
    const hourly = new SendCoordinator({
      delayMs: 0,
      maxRequestsPerMinute: 10,
      maxMessagesPerHour: 2,
      now: () => now,
      sleep: async () => undefined,
    });
    const tooMany = await hourly.run(3, async () => undefined);
    expect(tooMany).toEqual({ accepted: false, reason: 'rate_limited' });
  });

  it('blocks new sends while a timed-out send is still unresolved', async () => {
    const coordinator = new SendCoordinator({
      delayMs: 0,
      maxRequestsPerMinute: 10,
      maxMessagesPerHour: 30,
      sleep: async () => undefined,
    });
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = coordinator.run(1, async (slot) => {
      slot.holdUntilSettled(pending);
      return 'started';
    });
    await first;
    const second = await coordinator.run(1, async () => 'next');
    expect(second).toEqual({ accepted: false, reason: 'send_blocked' });
    release?.();
    await pending;
    await vi.waitFor(async () => {
      const third = await coordinator.run(1, async (slot) => {
        await slot.pace();
        slot.markAttempted();
        return 'after';
      });
      expect(third).toEqual({ accepted: true, value: 'after' });
    });
  });
});
