import { DisconnectReason } from '@whiskeysockets/baileys';
import { describe, expect, it } from 'vitest';
import { classifyDisconnect, computeReconnectDelay, DisconnectCode } from '../../src/core/whatsapp/reconnect-policy.js';

const policy = {
  initialDelayMs: 2000,
  maxDelayMs: 60_000,
  multiplier: 2,
  jitterRatio: 0.2,
};

describe('reconnect policy', () => {
  it('matches the Baileys disconnect codes used by this gateway', () => {
    expect(DisconnectReason.loggedOut).toBe(DisconnectCode.loggedOut);
    expect(DisconnectReason.badSession).toBe(DisconnectCode.badSession);
    expect(DisconnectReason.restartRequired).toBe(DisconnectCode.restartRequired);
    expect(DisconnectReason.connectionClosed).toBe(DisconnectCode.connectionClosed);
    expect(DisconnectReason.connectionLost).toBe(DisconnectCode.connectionLost);
    expect(DisconnectReason.timedOut).toBe(DisconnectCode.timedOut);
    expect(DisconnectReason.connectionReplaced).toBe(DisconnectCode.connectionReplaced);
    expect(DisconnectReason.multideviceMismatch).toBe(DisconnectCode.multideviceMismatch);
    expect(DisconnectReason.forbidden).toBe(DisconnectCode.forbidden);
    expect(DisconnectReason.unavailableService).toBe(DisconnectCode.unavailableService);
  });

  it('applies exponential backoff, jitter, and the maximum delay (TC-014)', () => {
    expect(computeReconnectDelay(1, policy, () => 0.5)).toBe(2000);
    expect(computeReconnectDelay(1, policy, () => 0)).toBe(1600);
    expect(computeReconnectDelay(1, policy, () => 1)).toBe(2400);
    expect(computeReconnectDelay(2, policy, () => 0.5)).toBe(4000);
    expect(computeReconnectDelay(3, policy, () => 0.5)).toBe(8000);
    expect(computeReconnectDelay(4, policy, () => 0.5)).toBe(16_000);
    expect(computeReconnectDelay(5, policy, () => 0.5)).toBe(32_000);
    expect(computeReconnectDelay(6, policy, () => 0.5)).toBe(60_000);
    expect(computeReconnectDelay(20, policy, () => 1)).toBe(60_000);
    expect(computeReconnectDelay(20, policy, () => 0)).toBe(48_000);
  });

  it('separates logout and invalid credentials from recoverable failures', () => {
    expect(classifyDisconnect(DisconnectCode.loggedOut)).toMatchObject({
      recoverable: false,
      state: 'LOGGED_OUT',
      category: 'logged_out',
    });
    expect(classifyDisconnect(DisconnectCode.badSession)).toMatchObject({
      recoverable: false,
      resetCredentials: true,
      category: 'credentials_invalid',
    });
    expect(classifyDisconnect(DisconnectCode.connectionClosed).recoverable).toBe(true);
    expect(classifyDisconnect(undefined).recoverable).toBe(true);
    expect(classifyDisconnect(DisconnectCode.restartRequired)).toMatchObject({
      recoverable: true,
      category: 'restart_required',
    });
  });
});
